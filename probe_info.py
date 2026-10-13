#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RYKEN 信息帧探针 probe_info.py
──────────────────────────────────────────────────────────────
目的（2026-10-09 起，一次跑完能定三件事）：
  1. SN      —— 信息帧 [16..19] 到底是 BCD 还是 HEX
  2. 版本号  —— [21] 是不是固件版本（v/100 编码：200 → "V2.00"）
  3. START 参数 —— [22][23] 是不是官方 START 里那 2 个字节
                     （抓到的官方帧 aa 0c ff "ready" 33 32 a1 20，[8][9]=参数、[10][11]=CRC16）

为什么要在 PC 上跑：
  Windows 的 HID 驱动路径是**已知能出流的**（bridge.py 实测 5.01V/1.9A），
  用它当参照物，才能把「表的问题」和「手机主机的问题」分开。
  vivo 上连 0x1A 应答都收不到，在手机上无法做任何对照。

用法：
    python probe_info.py                # 默认：只发 INFO，10 秒
    python probe_info.py --seconds 20
    python probe_info.py --passive      # 一个命令都不发，看设备是否主动推（应得 0 帧）
    python probe_info.py --full         # INFO + START + 1Hz KEEPALIVE（等价 bridge.py 的路径）
    python probe_info.py --start-only   # 只发 START（验证上一条 INFO 的参数是否有效）

⚠ 跑之前先把官方 RYKEN 上位机关掉，避免两边抢设备。
⚠ 本脚本只读/只发命令，不写任何文件、不改设备状态。
"""

import argparse
import ctypes as C
import re
import sys
import time

import bridge as B

# ── CRC16：多项式 0x2507 / 初值 0x11 / 结果 +1 / 不反转 ──────────────
def crc16(data: bytes) -> int:
    crc = 0x11
    for b in data:
        crc ^= (b & 0xFF) << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x2507) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return (crc + 1) & 0xFFFF


def build_start(param0: int, param1: int) -> bytes:
    """AA 0C FF "ready" + 2 字节参数 + CRC16(BE)"""
    body = bytes([0xAA, 0x0C, 0xFF]) + b'ready' + bytes([param0, param1])
    crc = crc16(body)
    return body + bytes([(crc >> 8) & 0xFF, crc & 0xFF])


# ── 同步头定位：PC 读 65B（含报告ID）→ idx=1；Android 读 64B → idx=0 ──
def sync_index(b: bytes) -> int:
    if len(b) >= 4 and b[0] == 0x55:
        return 0
    if len(b) >= 4 and b[1] == 0x55:
        return 1
    return -1


def hexs(b: bytes) -> str:
    return ' '.join('%02x' % x for x in b)


def analyse(b: bytes) -> str:
    i = sync_index(b)
    if i < 0:
        return '  ← 无 0x55 同步头'
    if len(b) <= i + 1:
        return '  ← 帧太短'
    t = b[i + 1]
    kind = {0x1B: '测量帧', 0x1A: '信息帧'}.get(t, '类型 0x%02X' % t)
    out = '  ← %s (sync@%d)' % (kind, i)
    if t == 0x1A and len(b) >= i + 20:
        sn = b[i + 16:i + 20]
        bcd, allbcd = '', True
        for v in sn:
            hi, lo = v >> 4, v & 0x0F
            if hi > 9 or lo > 9:
                allbcd = False
                break
            bcd += '%d%d' % (hi, lo)
        out += '\n     SN raw = %s' % hexs(sn)
        out += '\n     SN 当 BCD 读 = %s' % (bcd if allbcd else '(含非十进制数字，BCD 无效)')
        out += '\n     SN 当 HEX 读 = %s' % (''.join('%02X' % v for v in sn))
        if len(b) >= i + 26:
            tail = b[i + 20:i + 26]
            out += '\n     [20..25] = %s' % hexs(tail)
            out += '\n       [20]=%d  [21]=%d  ← 若按 v/100 编码：%s' % (
                tail[0], tail[1], ('V%d.%02d' % (tail[1] // 100, tail[1] % 100)) if 1 <= tail[1] <= 0xFE else '(0x00/0xFF 无效)')
            out += '\n       [22][23] = %02x %02x  ← 若作 START 参数，整帧应为：' % (tail[2], tail[3])
            out += '\n         %s' % hexs(build_start(tail[2], tail[3]))
    return out


def read_once(h, ev, timeout_ms: int):
    """返回 bytes；超时返回 b''；管道错误返回 None"""
    ov = B.OVERLAPPED()
    ov.hEvent = ev
    B.k32.ResetEvent(C.c_void_p(ev))
    buf = C.create_string_buffer(B.REPORT_LEN)
    got = C.c_ulong(0)
    ok = B.k32.ReadFile(C.c_void_p(h), buf, B.REPORT_LEN, C.byref(got), C.byref(ov))
    if not ok:
        if B.k32.GetLastError() != B.ERROR_IO_PENDING:
            return None
        if B.k32.WaitForSingleObject(C.c_void_p(ev), timeout_ms) != 0:
            B.k32.CancelIo(C.c_void_p(h))
            return b''
        B.k32.GetOverlappedResult(C.c_void_p(h), C.byref(ov), C.byref(got), False)
    return bytes(buf.raw[:got.value]) if got.value else b''


def send(h, ev, data: bytes) -> int:
    ov = B.OVERLAPPED()
    ov.hEvent = ev
    B.k32.ResetEvent(C.c_void_p(ev))
    buf = C.create_string_buffer(data, len(data))
    got = C.c_ulong(0)
    ok = B.k32.WriteFile(C.c_void_p(h), buf, len(data), C.byref(got), C.byref(ov))
    if not ok and B.k32.GetLastError() == B.ERROR_IO_PENDING:
        if B.k32.WaitForSingleObject(C.c_void_p(ev), 500) == 0:
            B.k32.GetOverlappedResult(C.c_void_p(h), C.byref(ov), C.byref(got), False)
    return got.value


def bcd_device_from_registry():
    """从注册表拿 bcdDevice：HKLM\\SYSTEM\\...\\Enum\\USB\\VID_2E3C&PID_AF03\\<SN> → 子键名含 REV_xxxx"""
    try:
        import winreg
    except Exception:
        return ''
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r'SYSTEM\CurrentControlSet\Enum\USB\VID_%04X&PID_%04X' % (B.VID, B.PID))
        n = winreg.QueryInfoKey(root)[0]
        for k in range(n):
            name = winreg.EnumKey(root, k)
            m = re.search(r'REV_([0-9A-Fa-f]{4})', name)
            if m:
                v = int(m.group(1), 16)
                return '%X.%02X (0x%04X)' % (v >> 8, v & 0xFF, v)
    except Exception:
        pass
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=10.0)
    ap.add_argument('--passive', action='store_true', help='不发任何命令，只看设备是否主动推')
    ap.add_argument('--start-only', action='store_true', help='只发 START（用固定参数），不发 INFO')
    ap.add_argument('--full', action='store_true', help='INFO + START + 1Hz KEEPALIVE')
    ap.add_argument('--info-every', type=float, default=0.7, help='INFO 重发间隔（秒）')
    args = ap.parse_args()

    path = B.find_device_path()
    if not path:
        print('✗ 没找到 RK-X3。请确认功率表已接到电脑（HID 接口，VID %04X:PID %04X）。' % (B.VID, B.PID))
        return 2
    info = B.read_strings(path)
    print('✓ 设备: %s  USB-SN=%s  (%s)' % (info.get('product'), info.get('serial'), info.get('manufacturer')))
    bcd = bcd_device_from_registry()
    print('  bcdDevice(注册表) = %s' % (bcd or '(读不到)'))
    print('  路径: %s' % path)
    print()

    h = B.k32.CreateFileW(path, B.GENERIC_READ | B.GENERIC_WRITE, 3, None,
                          B.OPEN_EXISTING, B.FILE_FLAG_OVERLAPPED, None)
    if not h:
        print('✗ 打不开设备（官方上位机是否还开着？）')
        return 3
    ev_r = B.k32.CreateEventW(None, True, False, None)
    ev_w = B.k32.CreateEventW(None, True, False, None)

    mode = 'passive' if args.passive else ('start-only' if args.start_only else ('full' if args.full else 'info-only'))
    print('模式 = %s，时长 %.1fs' % (mode, args.seconds))
    print('─' * 62)

    t0 = time.time()
    next_info = t0
    next_hb = t0
    frames = []
    info_frames = []
    try:
        while time.time() - t0 < args.seconds:
            now = time.time()
            if mode == 'info-only' and now >= next_info:
                send(h, ev_w, B.CMD_INFO)
                next_info = now + args.info_every
            elif mode == 'full':
                if now >= next_info:
                    send(h, ev_w, B.CMD_INFO)
                    next_info = now + args.info_every
                if now - t0 < 0.6 and len(frames) == 0 and now >= t0 + 0.5:
                    send(h, ev_w, B.CMD_START)
                if now >= next_hb:
                    send(h, ev_w, B.CMD_KEEPALIVE)
                    next_hb = now + 1.0
            elif mode == 'start-only' and now >= next_info:
                send(h, ev_w, B.CMD_START)
                next_info = now + 1.0

            d = read_once(h, ev_r, 200)
            if d is None:
                print('✗ 读失败（设备可能被独占）')
                break
            if not d:
                continue
            t = time.time() - t0
            frames.append(d)
            mark = '★' if (sync_index(d) >= 0 and d[sync_index(d) + 1] == 0x1A) else ' '
            print('%s [%6.3fs] len=%2d  %s' % (mark, t, len(d), hexs(d)))
            print(analyse(d))
            if mark == '★':
                info_frames.append(d)
    except KeyboardInterrupt:
        print('\n(手动中断)')
    finally:
        B.k32.CloseHandle(C.c_void_p(h))

    # ── 结论 ───────────────────────────────────────────────
    print('─' * 62)
    print('共收到 %d 帧，其中信息帧 %d 个' % (len(frames), len(info_frames)))
    if not frames:
        print('结论：设备在 %s 模式下**完全沉默**。' % mode)
        print('  → 与手机端 vivo 的表现一致 ⇒ 主机侧差异被排除，问题在设备/协议本身。')
    elif not info_frames:
        print('结论：有帧但没有信息帧 ⇒ INFO 命令没被应答，与 vivo 表现一致。')
    else:
        d = info_frames[0]
        i = sync_index(d)
        tail = d[i + 20:i + 26] if len(d) >= i + 26 else b''
        print('结论：拿到信息帧 ⇒ 表是活的、SN/版本/START 参数都能从这一帧取。')
        if len(tail) >= 4:
            p = (tail[2], tail[3])
            print('  START 参数候选 = %02x %02x' % p)
            print('  完整 START 帧   = %s' % hexs(build_start(*p)))
            print('  与 PC 表原值 33 32 %s' % ('相同 → 参数不是按表派生的，另找原因'
                                              if p == (0x33, 0x32) else '不同 → 按表/按会话派生成立 ★'))
            print('  把上面这条 START 帧填进 App 的 CMD_START（或等扫描命中）再试。')
        if bcd:
            print('  版本交叉验证：信息帧[21]=%d → %s ；bcdDevice=%s'
                  % (tail[1], 'V%d.%02d' % (tail[1] // 100, tail[1] % 100), bcd))
    return 0


if __name__ == '__main__':
    sys.exit(main())
