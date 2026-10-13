#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证"协议监听开闸"命令：只发 INFO→START→KEEPALIVE + AA 07 03 01 00 65 49，
   看设备是否开始上报协议帧（0x0B 文本事件 / 0x0C·0x10·0x20·0x28 PD 报文）。
   用法：python probe_proto_on.py [--seconds 25]
"""
import argparse
import ctypes as C
import time
from collections import Counter

import bridge as B

PROTO_ON = B._cmd(b'\xaa\x07\x03\x01\x00\x65\x49')      # 官方「PD协议分析仪·开始」同款


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=25.0)
    args = ap.parse_args()
    path = B.find_device_path()
    if not path:
        print('✗ 没找到 RK-X3'); return 2
    print('✓', B.read_strings(path).get('product'), '— 开始验证"开闸"命令')
    h = B.k32.CreateFileW(path, B.GENERIC_READ | B.GENERIC_WRITE, 3, None, B.OPEN_EXISTING,
                          B.FILE_FLAG_OVERLAPPED, None)
    ev_r = B.k32.CreateEventW(None, True, False, None)
    ev_w = B.k32.CreateEventW(None, True, False, None)

    def rd(ms=200):
        ov = B.OVERLAPPED(); ov.hEvent = ev_r
        B.k32.ResetEvent(C.c_void_p(ev_r))
        buf = C.create_string_buffer(B.REPORT_LEN); got = C.c_ulong(0)
        ok = B.k32.ReadFile(C.c_void_p(h), buf, B.REPORT_LEN, C.byref(got), C.byref(ov))
        if not ok:
            if B.k32.GetLastError() != B.ERROR_IO_PENDING: return None
            if B.k32.WaitForSingleObject(C.c_void_p(ev_r), ms) != 0:
                B.k32.CancelIo(C.c_void_p(h)); return b''
            B.k32.GetOverlappedResult(C.c_void_p(h), C.byref(ov), C.byref(got), False)
        return bytes(buf.raw[:got.value]) if got.value else b''

    def wr(d):
        ov = B.OVERLAPPED(); ov.hEvent = ev_w
        B.k32.ResetEvent(C.c_void_p(ev_w))
        buf = C.create_string_buffer(d, len(d)); got = C.c_ulong(0)
        ok = B.k32.WriteFile(C.c_void_p(h), buf, len(d), C.byref(got), C.byref(ov))
        if not ok and B.k32.GetLastError() == B.ERROR_IO_PENDING:
            if B.k32.WaitForSingleObject(C.c_void_p(ev_w), 500) == 0:
                B.k32.GetOverlappedResult(C.c_void_p(h), C.byref(ov), C.byref(got), False)
        return got.value

    print('  发 INFO…'); wr(B.CMD_INFO)
    t0 = time.time()
    while time.time() - t0 < 1.0:
        d = rd(150)
        if d and len(d) > 2:
            i = 0 if d[0] == 0x55 else 1
            if i + 1 < len(d) and d[i + 1] == 0x1A:
                print('  ✓ 收到信息帧（握手 OK）'); break
    print('  发 START…'); wr(B.CMD_START)
    time.sleep(0.4)
    print('  发「开闸」命令 AA 07 03 01 00 65 49 …'); wr(PROTO_ON)

    types = Counter(); special = []
    t0 = time.time(); next_hb = t0
    while time.time() - t0 < args.seconds:
        if time.time() >= next_hb:
            wr(B.CMD_KEEPALIVE); next_hb = time.time() + 1.0
        d = rd(150)
        if not d or len(d) < 3: continue
        i = 0 if d[0] == 0x55 else 1
        if i + 1 >= len(d): continue
        t = d[i + 1]; types[t] += 1
        if t not in (0x1A, 0x1B):
            special.append(d)
            print('  ★ 类型 0x%02X: %s' % (t, ' '.join('%02x' % x for x in d[:28])))
    B.k32.CloseHandle(C.c_void_p(h))
    print('\n帧类型直方图:', {hex(k): v for k, v in sorted(types.items())})
    if special:
        print('✓ 设备已开始上报协议帧（%d 条）——「开闸」命令有效，且不依赖官方上位机' % len(special))
    else:
        print('✗ 没收到协议帧。可能这段窗口内没有 PD 通信（拔插一次充电头再试）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
