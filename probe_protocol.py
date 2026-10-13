#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RYKEN 协议通道嗅探器 probe_protocol.py
──────────────────────────────────────────────────────────────
用途：把设备→主机的 **所有类型** 帧抓下来（重点是除 0x1A/0x1B 以外的新帧类型），
      为「手机端显示充电协议 / PD 报文」找数据源。

背景（2026-10-10 分析）：
  - 0x1B 测量帧 = V/I/D+/D-/CC1/CC2/温度 + CRC16 + 内部遥测尾，**不含协议信息**；
  - PC 上位机「PD协议分析仪」能列 PD 报文 → 设备在收到"开启协议监听"命令后会推
    协议数据帧（类型未知，预计 0x1C/0x1D...）。开启命令本身用调试注入抓
    （见 .tmp-fw2/hooks/hook_writes.py）。
  - 本脚本负责：把那些"没见过"的帧原样抓到日志里。

用法：
  # A. 独立开流（不依赖官方软件；自己发 INFO+START+KEEPALIVE）
  python probe_protocol.py --seconds 60

  # B. 配合官方上位机抓协议（推荐；让 app 去发命令，本脚本只收帧）
  python probe_protocol.py --passive --seconds 120

  # 日志默认写 protocol_capture_<时间戳>.log；--out 指定文件名

正式抓协议流程（待用户配合，一次搞定）：
  1. 功率表插电脑（HID 口）+ 接一个 PD 充电头（最好再带手机当负载）
  2. 启动官方上位机 RYKEN（app.exe）
  3. 另开一个终端跑 hook_writes.py（会自己拉起被调试的 app.exe，抓全部写命令）
  4. 本脚本用 --passive 在旁边同时跑（收帧）
  5. 在官方上位机里进入「PD协议分析仪」页，点「开始」
  6. 等 10~20 秒；两边分别 Ctrl+C 收工
  7. 把两个日志发回：hook_*.log（命令）+ protocol_capture_*.log（帧）

⚠ 只读设备；--passive 完全不发命令。默认模式的命令与 bridge.py 完全相同。
"""

import argparse
import ctypes as C
import sys
import time
from collections import Counter

import bridge as B


# ── CRC16：多项式 0x2507 / 初值 0x11 / 结果 +1 / 不反转（帧与命令同一算法）──
def crc16(data: bytes) -> int:
    crc = 0x11
    for b in data:
        crc ^= (b & 0xFF) << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x2507) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return (crc + 1) & 0xFFFF


def sync_index(b: bytes) -> int:
    if len(b) >= 4 and b[0] == 0x55:
        return 0
    if len(b) >= 4 and b[1] == 0x55:
        return 1
    return -1


def crc_check(b: bytes, i: int):
    """0x1A 覆盖 24B / 0x1B 覆盖 25B；CRC 大端存在覆盖段后 2 字节。返回 True/False/None"""
    if i + 1 >= len(b):
        return None
    t = b[i + 1]
    L = {0x1A: 24, 0x1B: 25}.get(t)
    if not L or len(b) < i + L + 2:
        return None
    want = (b[i + L] << 8) | b[i + L + 1]
    return want == crc16(b[i:i + L])


def hexs(b: bytes) -> str:
    return ' '.join('%02x' % x for x in b)


def read_once(h, ev, timeout_ms: int):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=60.0, help='抓取时长（秒），Ctrl+C 可提前收')
    ap.add_argument('--passive', action='store_true', help='不发任何命令，只听（配合官方软件用）')
    ap.add_argument('--out', default='', help='日志文件名（默认 protocol_capture_<时间戳>.log）')
    args = ap.parse_args()

    path = B.find_device_path()
    if not path:
        print('✗ 没找到 RK-X3（VID %04X:PID %04X）。确认功率表 HID 口已插电脑。' % (B.VID, B.PID))
        return 2
    info = B.read_strings(path)
    print('✓ 设备: %s  USB-SN=%s' % (info.get('product'), info.get('serial')))
    print('  模式: %s，时长 %.0fs' % ('passive（只听）' if args.passive else '主动开流', args.seconds))

    h = B.k32.CreateFileW(path, B.GENERIC_READ | B.GENERIC_WRITE, 3, None,
                          B.OPEN_EXISTING, B.FILE_FLAG_OVERLAPPED, None)
    if not h:
        print('✗ 打不开设备（官方上位机开着也没关系；若失败请重插一次）')
        return 3
    ev_r = B.k32.CreateEventW(None, True, False, None)
    ev_w = B.k32.CreateEventW(None, True, False, None)

    stamp = time.strftime('%Y%m%d_%H%M%S')
    fn = args.out or ('protocol_capture_%s.log' % stamp)
    log = open(fn, 'w', encoding='utf-8')
    log.write('# RYKEN protocol capture %s\n# device: %s\n# mode: %s\n'
              % (stamp, info.get('product', '?'), 'passive' if args.passive else 'active'))

    type_count = Counter()
    unknown = Counter()      # 非 0x1A/0x1B 类型帧计数
    unknown_samples = []     # 前若干条未知帧完整 hex
    crc_bad = 0
    total = 0
    big_shown = 0

    t0 = time.time()
    next_hb = t0
    started = False
    kick_retry = 0

    print('─' * 66)
    try:
        while time.time() - t0 < args.seconds:
            now = time.time()

            if not args.passive:
                # 开流节奏与官方一致：INFO → START → 1Hz KEEPALIVE
                if not started:
                    send(h, ev_w, B.CMD_INFO)
                    time.sleep(0.05)
                    send(h, ev_w, B.CMD_START)
                    started = True
                    next_hb = now + 1.0
                elif now >= next_hb:
                    send(h, ev_w, B.CMD_KEEPALIVE)
                    next_hb = now + 1.0
                # 2 秒还没出流 → 补一轮 INFO+START
                if total == 0 and now - t0 > 2.0 and now - t0 < args.seconds - 2.0:
                    if kick_retry < 5 and now - t0 > 2.0 + kick_retry * 1.0:
                        send(h, ev_w, B.CMD_INFO)
                        time.sleep(0.03)
                        send(h, ev_w, B.CMD_START)
                        kick_retry += 1

            d = read_once(h, ev_r, 200)
            if d is None:
                print('✗ 读失败（设备可能被独占）')
                break
            if not d:
                continue

            t = time.time() - t0
            total += 1
            i = sync_index(d)
            ftype = d[i + 1] if i >= 0 and i + 1 < len(d) else -1
            type_count[ftype] += 1
            ok = crc_check(d, i) if i >= 0 else None
            if ok is False:
                crc_bad += 1
            tag = ''
            if ok is True:
                tag = 'CRC✓'
            elif ok is False:
                tag = 'CRC✗'
            log.write('[%7.3f] len=%2d %s  %s\n' % (t, len(d), tag, hexs(d)))

            # 控制台输出策略：0x1B 不刷屏，其它都打
            if ftype != 0x1B:
                print('★ [%7.3fs] 类型 0x%02X len=%d %s' % (t, ftype & 0xFF, len(d), tag))
                print('    %s' % hexs(d))
                if ftype not in (0x1A,):
                    unknown[ftype] += 1
                    if len(unknown_samples) < 30:
                        unknown_samples.append(d)
                    big_shown += 1
            elif total % 100 == 0:
                print('  [%7.1fs] 0x1B 已收 %d 帧（CRC✗ %d）' % (t, type_count[0x1B], crc_bad))
    except KeyboardInterrupt:
        print('\n(手动中断)')
    finally:
        log.write('\n# 汇总: frames=%d  types=%s  crc_bad=%d\n' % (total, dict(type_count), crc_bad))
        log.close()
        B.k32.CloseHandle(C.c_void_p(h))

    print('─' * 66)
    print('共 %d 帧；类型直方图: %s' % (total, {('0x%02X' % k) if k >= 0 else '未知': v
                                                  for k, v in sorted(type_count.items())}))
    print('CRC 校验失败: %d' % crc_bad)
    if unknown:
        print('⚠ 发现新帧类型（协议数据的重点嫌疑）: %s' % {('0x%02X' % k): v for k, v in unknown.items()})
    else:
        print('没有出现新类型帧。若刚才没点官方软件的「开始」，先点了再重抓。')
    print('日志: %s' % fn)
    return 0


if __name__ == '__main__':
    sys.exit(main())
