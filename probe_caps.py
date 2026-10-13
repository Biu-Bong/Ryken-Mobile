#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RYKEN HID 接口能力实测 probe_caps.py  （2026-10-12）

目的：把固件里挖出来的命令表逐条打一遍，看设备到底回什么。
  A. 只读安全项：CMD0(INFO) / CMD2(accept 回显)
  B. 开关项：    CMD1(暂停流) / CMD5(彻底关流) / CMD6(KEEPALIVE)
  C. 非常规帧：  55 帧(灌数据) / A5 帧(配置类 sub1 sub3)

⛔⛔ CMD4 已永久拉黑，本脚本不再提供（2026-10-12 事故）：
   它的固件实现是 FLASH_Unlock() + FLASH_EraseSector(0x08007800) + 只写回 5 个字，
   而 0x08007800 那 2KB 页在固件里是**代码**（bin offset 0x7800 处 0xFF 仅占 2%）
   → 整页被擦、只补回 20B → 固件被削掉 2KB → 设备跑飞并被打进 IAP 模式（屏幕显示 HID IAP）。
   它照样回 `55 0B 04 "accept"`，从响应上完全看不出破坏性。
   ⚠ 规则：测任何"官方从没用过"的命令前，先反汇编它的实现，确认没有 Erase/Program/Reset 调用。

用法：
    python probe_caps.py                # 跑全套（不含 CMD4）
    python probe_caps.py --only 2,1     # 只跑指定项
    python probe_caps.py --no-risky     # 跳过 55 帧 / A5 帧

⚠ 跑之前关掉官方 RYKEN 上位机。
⚠ CRC 算法：poly 0x2507 / init 0x11 / 结果 +1 / 不反转 / 大端
⚠ PC 端 WriteFile 必须带 1 字节报告 ID 前缀（65B）
"""
import argparse
import ctypes as C
import sys
import threading
import time
from ctypes import wintypes

import bridge as B  # noqa: E402  (复用其 find_device_path / OVERLAPPED / argtypes 声明)

k32 = B.k32
k32.CancelIo.restype = C.c_int
k32.CancelIo.argtypes = [C.c_void_p]
k32.GetLastError.restype = C.c_ulong
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
ERROR_IO_PENDING = 997
REPORT_LEN = 65


def crc16(data: bytes) -> int:
    crc = 0x11
    for b in data:
        crc ^= (b & 0xFF) << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x2507) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return (crc + 1) & 0xFFFF


def frame(body: bytes) -> bytes:
    """body 不含 CRC → 补 CRC → 补 0 → 加报告 ID → 65B"""
    c = crc16(body)
    full = body + bytes([(c >> 8) & 0xFF, c & 0xFF])
    return bytes([0x00]) + full + b'\x00' * (REPORT_LEN - 1 - len(full))


# ── 命令构造 ──────────────────────────────────────────────
def cmd(cmdbyte: int, *data: int) -> bytes:
    """LEN = 整帧字节数 = 3(AA,LEN,CMD) + len(data) + 2(CRC)"""
    body = bytes([0xAA, 5 + len(data), cmdbyte]) + bytes(data)
    return frame(body)


def build_start(p0: int, p1: int) -> bytes:
    return frame(bytes([0xAA, 0x0C, 0xFF]) + b'ready' + bytes([p0, p1]))


def frame55(payload: bytes, length: int) -> bytes:
    """55 帧：buf[0]=0x55, buf[1]=LEN, 后面跟 payload（不追加 CRC，固件该分支不校 CRC）"""
    return bytes([0x00, 0x55, length]) + payload + b'\x00' * (REPORT_LEN - 3 - len(payload))


def frame55_crc(payload: bytes, length: int) -> bytes:
    body = bytes([0x55, length]) + payload
    return frame(body)


def framea5(sub: int, *data: int) -> bytes:
    body = bytes([0xA5, 0xA5, sub]) + bytes(data)
    return frame(body)


# ── 设备 IO ───────────────────────────────────────────────
class Dev:
    def __init__(self, path):
        self.path = path
        self.h = None
        self.ev_r = None
        self.ev_w = None
        self.frames = []
        self.lock = threading.Lock()
        self.running = False

    def open(self):
        self.h = k32.CreateFileW(self.path, GENERIC_READ | GENERIC_WRITE, 3, None,
                                 OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
        if not self.h or self.h == C.c_void_p(-1).value:
            self.h = None
            return False
        self.ev_r = k32.CreateEventW(None, True, False, None)
        self.ev_w = k32.CreateEventW(None, True, False, None)
        return True

    def write(self, data: bytes):
        if not self.h:
            return
        o = B.OVERLAPPED(); o.hEvent = C.c_void_p(self.ev_w)
        buf = C.create_string_buffer(data, len(data))
        got = C.c_ulong(0)
        k32.ResetEvent(C.c_void_p(self.ev_w))
        ok = k32.WriteFile(C.c_void_p(self.h), buf, len(data), C.byref(got), C.byref(o))
        if not ok:
            if k32.GetLastError() == ERROR_IO_PENDING:
                if k32.WaitForSingleObject(C.c_void_p(self.ev_w), 800) != 0:
                    k32.CancelIo(C.c_void_p(self.h))
                    k32.WaitForSingleObject(C.c_void_p(self.ev_w), 500)
        # o 是局部变量：必须等 IO 真正落地后再离开作用域，否则内核写已回收内存

    def reader(self):
        self.running = True
        o = B.OVERLAPPED(); o.hEvent = C.c_void_p(self.ev_r)
        while self.running and self.h:
            buf = C.create_string_buffer(REPORT_LEN)
            got = C.c_ulong(0)
            k32.ResetEvent(C.c_void_p(self.ev_r))
            ok = k32.ReadFile(C.c_void_p(self.h), buf, REPORT_LEN, C.byref(got), C.byref(o))
            if not ok:
                if k32.GetLastError() != ERROR_IO_PENDING:
                    time.sleep(0.2)
                    continue
                if k32.WaitForSingleObject(C.c_void_p(self.ev_r), 1000) != 0:
                    # ⚠ 必须 CancelIo：否则 o 被回收后内核仍会写它 → 段错误
                    k32.CancelIo(C.c_void_p(self.h))
                    k32.WaitForSingleObject(C.c_void_p(self.ev_r), 300)
                    continue
                k32.GetOverlappedResult(C.c_void_p(self.h), C.byref(o), C.byref(got), False)
            if got.value > 0:
                with self.lock:
                    self.frames.append((time.time(), bytes(buf[:got.value])))

    def drain(self):
        with self.lock:
            f = self.frames
            self.frames = []
            return f


def typ(b: bytes):
    i = 1 if len(b) > 1 and b[1] == 0x55 else (0 if b and b[0] == 0x55 else -1)
    if i < 0 or len(b) <= i + 1:
        return '??'
    t = b[i + 1]
    return {0x1A: '0x1A信息', 0x1B: '0x1B测量', 0x30: '0x30PD', 0x0B: '0x0B文本'}.get(t, '类型%02X' % t)


def hexs(b: bytes, n=24):
    return ' '.join('%02x' % x for x in b[:n])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--no-risky', action='store_true')
    ap.add_argument('--wait', type=float, default=1.6)
    args = ap.parse_args()

    path = B.find_device_path()
    if not path:
        print('设备未找到。确认已插上 HID 口、官方上位机已关闭。')
        return
    print('设备:', path[:70])

    d = Dev(path)
    if not d.open():
        print('打开失败')
        return
    threading.Thread(target=d.reader, daemon=True).start()

    # ── 握手：INFO → 取 START 参数 → START ──────────────────
    print('\n=== 握手 ===')
    d.drain()
    d.write(cmd(0x00, 0x1A, 0x0A, 0x09, 0x0B, 0x0F))   # 先用已知 INFO
    time.sleep(1.2)
    fs = d.drain()
    p0 = p1 = None
    for t, b in fs:
        print(f'  [{typ(b)}] {hexs(b, 40)}')
        if typ(b) == '0x1A信息' and len(b) >= 26:
            i = 1                      # sync 下标（PC 端 65B，报告 ID 占 idx0）
            print(f'     固件版本[{i+21}] = 0x{b[i+21]:02x}  '
                  f'SN[{i+16}..{i+19}] = {b[i+16]:02x} {b[i+17]:02x} {b[i+18]:02x} {b[i+19]:02x}')
            p0, p1 = b[i + 22], b[i + 23]
    if p0 is None:
        print('  ⚠ 没拿到 0x1A 信息帧，START 参数未知，用默认 33 32')
        p0, p1 = 0x33, 0x32
    print(f'  START 参数 = {p0:02x} {p1:02x}')

    d.write(build_start(p0, p1))
    time.sleep(2.0)
    n = len(d.drain())
    print(f'  START 后 {n} 帧 → 流{"已开" if n else "未开"}')
    if not n:
        print('  数据流没起来，后续命令仍会测，但注意"流开着"是 CMD2/3 的前置条件')

    def keepalive():
        for _ in range(2):
            d.write(cmd(0x06, 0x01))
            time.sleep(0.3)

    def test(name, data, wait=None, note='', resume=None):
        w = wait or args.wait
        print(f'\n=== {name} ===  {note}')
        keepalive()
        d.drain()
        d.write(data)
        time.sleep(w)
        fs = d.drain()
        if not fs:
            print('  ✗ 无响应（静默）')
        else:
            seen = {}
            for t, b in fs:
                k = typ(b)
                seen.setdefault(k, b)
            for k, b in seen.items():
                print(f'  ✓ [{k}] {hexs(b, 32)}')
            print(f'    （共 {len(fs)} 帧）')
        if resume:
            resume()
        return fs

    def restart():
        d.write(build_start(p0, p1))
        time.sleep(1.5)
        d.drain()

    tests = []
    # 💀 CMD4 已永久拉黑（2026-10-12 实锤事故）——代码保留在此仅作记录，不要取消注释：
    #   FLASH_Unlock() + FLASH_EraseSector(0x08007800) + 只写回 5 个字
    #   → 0x08007800 那页 2KB 在固件里是代码，被整页擦掉只补回 20B
    #   → 固件受损 → 设备被打进 IAP 模式。响应却仍是人畜无害的 `55 0B 04 "accept"`。
    # tests.append(('4', 'CMD4 读片上 Flash 0x08007800', lambda: test(
    #     'CMD4', cmd(0x04, 0x01), 2.0, 'buf[3] 必须=1；官方从未用过')))
    tests.append(('2', 'CMD2 回 accept', lambda: test(
        'CMD2', cmd(0x02, 0x01), 2.0, '需流已开')))
    tests.append(('1', 'CMD1 暂停流', lambda: test(
        'CMD1', cmd(0x01), 2.5, '会停流 → 测完自动重启流', resume=restart)))
    tests.append(('5', 'CMD5 彻底关流', lambda: test(
        'CMD5', cmd(0x05, 0x01), 2.5, '会彻底停流 → 测完自动重启流', resume=restart)))
    tests.append(('55a', '55 帧 LEN=0x18', lambda: test(
        '55 帧 LEN=0x18', frame55(bytes(range(0x20, 0x50)), 0x18), 2.0, '灌 48B 到 0x20005C08')))
    tests.append(('55b', '55 帧 LEN=0x10 带CRC', lambda: test(
        '55 帧 LEN=0x10+CRC', frame55_crc(bytes([0x11] * 12), 0x10), 2.0, '走分包路径')))
    tests.append(('a51', 'A5 sub1', lambda: test(
        'A5 sub1', framea5(0x01), 2.0, '停流标记', resume=restart)))
    tests.append(('a53', 'A5 sub3', lambda: test(
        'A5 sub3', framea5(0x03), 2.0, '直接回 64B')))

    only = [x.strip() for x in args.only.split(',') if x.strip()]
    risky = {'4', '55a', '55b', 'a51', 'a53'}   # '4' = CMD4 破坏性，护栏常留
    for key, desc, fn in tests:
        if only and key not in only:
            continue
        if args.no_risky and key in risky:
            print(f'\n=== {desc} === 已跳过（--no-risky）')
            continue
        try:
            fn()
        except Exception as e:
            print(f'  ! 异常: {e}')

    # 收尾：恢复数据流
    keepalive()
    print('\n完成。')
    d.running = False


if __name__ == '__main__':
    main()
