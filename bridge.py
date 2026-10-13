#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RYKEN 桥接服务 bridge.py
─────────────────────────────────────────────────────────
作用：把插在电脑上的 RK-X3 功率表，通过 WiFi 转发给手机浏览器。
      一个进程同时做两件事：
        1) 托管手机端网页（手机直接打开 http://<电脑IP>:8765）
        2) WebSocket (/ws) 推送功率表数据

依赖：只用 Python 标准库，无需 pip install。

用法：
    python bridge.py                 # 默认 0.0.0.0:8765
    python bridge.py --port 9000
    python bridge.py --no-serve      # 只开 WebSocket，不开网页

设备识别：USB HID，VID 0x2E3C / PID 0xAF03，UsagePage 0xFF00，
         输入报告 65 字节（报告ID + 64 字节负载），设备主动以 ~166Hz 推送。
"""

import argparse
import base64
import ctypes as C
import hashlib
import http.server
import json
import os
import socketserver
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))

VID = 0x2E3C
PID = 0xAF03
REPORT_LEN = 65

# ── 开流协议（2026-10-09 实测破解）──────────────────────────
# 65 字节写缓冲 = 报告ID(0x00) + 64 字节负载；[1]=0xAA 魔数 [2]=长度
#   START 单发约 4.5 秒数据窗口（会自动停）；KEEPALIVE 1Hz 持续续期；
#   INFO 查询设备信息（设备回 0x1A 帧，含 BCD 压缩 SN）。
# 官方上位机 = 开机发一次 START + 每秒一个 KEEPALIVE。
def _cmd(head: bytes) -> bytes:
    return head + b'\x00' * (REPORT_LEN - len(head))


CMD_INFO      = _cmd(b'\x00\xaa\x0a\x00\x1a\x0a\x09\x0b\x0f\x5a\x45')
CMD_START     = _cmd(b'\x00\xaa\x0c\xff\x72\x65\x61\x64\x79\x33\x32\xa1\x20')
CMD_KEEPALIVE = _cmd(b'\x00\xaa\x06\x06\x01\xa6\x97')

# ══════════════════════════════════════════════════════════
#  1. HID 设备枚举与读取（Win32 原生 API，无需 hidapi）
# ══════════════════════════════════════════════════════════
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
ERROR_IO_PENDING = 997

setupapi = C.WinDLL('setupapi')
hid = C.WinDLL('hid')
k32 = C.WinDLL('kernel32')

k32.CreateFileW.restype = C.c_void_p
k32.CreateFileW.argtypes = [C.c_wchar_p, C.c_ulong, C.c_ulong, C.c_void_p,
                            C.c_ulong, C.c_ulong, C.c_void_p]
k32.ReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.c_void_p]
k32.WriteFile.argtypes = [C.c_void_p, C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.c_void_p]
k32.GetOverlappedResult.argtypes = [C.c_void_p, C.c_void_p, C.POINTER(C.c_ulong), C.c_int]
k32.CloseHandle.argtypes = [C.c_void_p]
# 注意：必须显式声明 restype，否则 64 位下 HANDLE 会被截断成 c_int，事件对象失效
k32.CreateEventW.restype = C.c_void_p
k32.CreateEventW.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_wchar_p]
k32.WaitForSingleObject.restype = C.c_ulong
k32.WaitForSingleObject.argtypes = [C.c_void_p, C.c_ulong]


class GUID(C.Structure):
    _fields_ = [("D1", C.c_ulong), ("D2", C.c_ushort), ("D3", C.c_ushort), ("D4", C.c_ubyte * 8)]


HID_GUID = GUID(0x4D1E55B2, 0xF16F, 0x11CF, (C.c_ubyte * 8)(0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30))


class DID(C.Structure):
    _fields_ = [("cbSize", C.c_ulong), ("g", GUID), ("Flags", C.c_ulong), ("Reserved", C.c_void_p)]


class OVERLAPPED(C.Structure):
    _fields_ = [("Internal", C.c_void_p), ("InternalHigh", C.c_void_p),
                ("Offset", C.c_ulong), ("OffsetHigh", C.c_ulong), ("hEvent", C.c_void_p)]


def find_device_path():
    """返回 RYKEN 功率表的 HID 接口路径，找不到返回 None"""
    setupapi.SetupDiGetClassDevsW.restype = C.c_void_p
    setupapi.SetupDiGetClassDevsW.argtypes = [C.POINTER(GUID), C.c_wchar_p, C.c_void_p, C.c_ulong]
    h = setupapi.SetupDiGetClassDevsW(C.byref(HID_GUID), None, None, 0x02 | 0x10)
    if not h:
        return None
    out = []
    i = 0
    while True:
        d = DID(); d.cbSize = C.sizeof(DID)
        if not setupapi.SetupDiEnumDeviceInterfaces(C.c_void_p(h), None, C.byref(HID_GUID),
                                                    C.c_ulong(i), C.byref(d)):
            break
        i += 1
        need = C.c_ulong(0)
        setupapi.SetupDiGetDeviceInterfaceDetailW(C.c_void_p(h), C.byref(d), None, 0, C.byref(need), None)
        buf = C.create_string_buffer(need.value)
        C.cast(buf, C.POINTER(C.c_ulong))[0] = 8      # 64 位下该结构 cbSize = 8
        if setupapi.SetupDiGetDeviceInterfaceDetailW(C.c_void_p(h), C.byref(d), buf, need.value,
                                                     C.byref(need), None):
            p = C.cast(C.addressof(buf) + C.sizeof(C.c_ulong), C.c_wchar_p).value
            if p:
                out.append(p)
    for p in out:
        if f'vid_{VID:04x}' in p.lower() and f'pid_{PID:04x}' in p.lower():
            return p
    return None


def read_strings(path):
    """读厂商 / 产品 / 序列号"""
    h = k32.CreateFileW(path, 0, 3, None, OPEN_EXISTING, 0, None)
    if not h:
        return {}
    res = {}
    for fn, key in ((hid.HidD_GetManufacturerString, 'manufacturer'),
                    (hid.HidD_GetProductString, 'product'),
                    (hid.HidD_GetSerialNumberString, 'serial')):
        b = C.create_unicode_buffer(260)
        if fn(C.c_void_p(h), b, 520):
            res[key] = b.value
    k32.CloseHandle(C.c_void_p(h))
    return res


class HidReader(threading.Thread):
    """持续读取功率表推送的报告，回调 on_frame(bytes, ts)"""

    def __init__(self, path, on_frame, on_status=None):
        super().__init__(daemon=True)
        self.path = path
        self.on_frame = on_frame
        self.on_status = on_status or (lambda s: None)
        self.running = False
        self.handle = None
        self.wev = None
        self.last_hb = 0.0
        self.last_start = 0.0

    def open(self):
        # 需要 GENERIC_WRITE：要发开流/保活命令
        self.handle = k32.CreateFileW(self.path, GENERIC_READ | GENERIC_WRITE, 3, None,
                                      OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
        return bool(self.handle)

    def send_cmd(self, data: bytes):
        """向设备写 65 字节命令（overlapped，本句柄已带 FILE_FLAG_OVERLAPPED）"""
        if not self.handle:
            return
        if self.wev is None:
            self.wev = k32.CreateEventW(None, True, False, None)
        ov = OVERLAPPED(); ov.hEvent = self.wev
        k32.ResetEvent(C.c_void_p(self.wev))
        buf = C.create_string_buffer(data, len(data))
        got = C.c_ulong(0)
        ok = k32.WriteFile(C.c_void_p(self.handle), buf, len(data), C.byref(got), C.byref(ov))
        if not ok and k32.GetLastError() == ERROR_IO_PENDING:
            if k32.WaitForSingleObject(C.c_void_p(self.wev), 500) == 0:
                k32.GetOverlappedResult(C.c_void_p(self.handle), C.byref(ov), C.byref(got), False)

    def run(self):
        self.running = True
        ev = k32.CreateEventW(None, True, False, None)
        idle_since = time.time()
        while self.running:
            # 确保句柄；每次打开后立即发开流握手（官方：INFO + START）
            if not self.handle:
                if not self.open():
                    self.on_status('无法打开设备')
                    time.sleep(1.0)
                    continue
                self.on_status('已连接')
                idle_since = time.time()
                self.send_cmd(CMD_INFO)
                self.send_cmd(CMD_START)
                self.last_start = time.time()
                self.last_hb = time.time()

            now = time.time()
            # 看门狗①：流停了 → 补发 START 重新开流；仍无数据则重开句柄
            if now - idle_since > 2.5 and now - self.last_start > 2.5:
                self.send_cmd(CMD_START)
                self.last_start = now
            if now - idle_since > 8.0:
                k32.CloseHandle(C.c_void_p(self.handle))
                self.handle = None
                time.sleep(0.5)
                continue
            # 看门狗②：1Hz 保活心跳（流寿命约 4.5s，断心跳则停流）
            if now - self.last_hb >= 1.0:
                self.send_cmd(CMD_KEEPALIVE)
                self.last_hb = now

            ov = OVERLAPPED(); ov.hEvent = ev
            k32.ResetEvent(C.c_void_p(ev))
            buf = C.create_string_buffer(REPORT_LEN)
            got = C.c_ulong(0)
            ok = k32.ReadFile(C.c_void_p(self.handle), buf, REPORT_LEN, C.byref(got), C.byref(ov))
            if not ok:
                if k32.GetLastError() != ERROR_IO_PENDING:
                    self.on_status('读取失败，设备可能已拔出')
                    if self.handle:
                        k32.CloseHandle(C.c_void_p(self.handle))
                        self.handle = None
                    time.sleep(1.0)
                    continue
                if k32.WaitForSingleObject(C.c_void_p(ev), 1000) != 0:
                    k32.CancelIo(C.c_void_p(self.handle))
                    continue
                k32.GetOverlappedResult(C.c_void_p(self.handle), C.byref(ov), C.byref(got), False)
            if got.value:
                idle_since = time.time()
                self.on_frame(buf.raw[:got.value], time.time())
        if self.handle:
            k32.CloseHandle(C.c_void_p(self.handle))
        self.running = False


# ══════════════════════════════════════════════════════════
#  2. 报文解码（协议已实测破解 2026-10-09，与官方界面逐值核对）
#     测量帧：i=同步头 0x55 下标（PC 帧在 1，Android 帧在 0）
#       i+3..i+6   VBUS 大端 float32 (V)
#       i+7..i+10  IBUS 大端 float32 (A)     PWR = V × I
#       i+11..i+12 D+  大端 u16 (mV)
#       i+13..i+14 D-  大端 u16 (mV)
#       i+15..i+16 CC1 大端 u16 (mV)
#       i+17..i+18 CC2 大端 u16 (mV)
#       i+19..i+20 温度 大端 u16 (℃)
#     容量/能量 = 上位机对电流/功率积分（官方 CSV: charge/energy）
#     信息帧：0x1A，SN 在 i+16..i+19（BCD 压缩）
# ══════════════════════════════════════════════════════════
DECODE_READY = True

_LAST_T = [0.0]      # ms
_CAP = [0.0]         # mAh
_WH = [0.0]          # Wh


def decode(frame: bytes):
    """把设备报告解析为 {vbus, ibus, pwr, cc1, cc2, dp, dm, temp, cap, wh}"""
    b = frame
    if len(b) >= 4 and b[1] == 0x55:
        i = 1
    elif len(b) >= 4 and b[0] == 0x55:
        i = 0
    else:
        return None
    if b[i + 1] != 0x1B or len(b) < i + 21:
        return None
    v = struct.unpack_from('>f', b, i + 3)[0]
    a = struct.unpack_from('>f', b, i + 7)[0]
    if v != v or a != a:          # NaN 防护
        return None

    def u16(o):
        return (b[i + o] << 8) | b[i + o + 1]

    dp, dm = u16(11) / 1000, u16(13) / 1000
    cc1, cc2 = u16(15) / 1000, u16(17) / 1000
    temp = u16(19)

    t_ms = time.time() * 1000
    if t_ms < _LAST_T[0] or t_ms - _LAST_T[0] >= 2000:
        _CAP[0] = 0.0; _WH[0] = 0.0      # 重连/断流 → 新会话
    elif t_ms > _LAST_T[0]:
        dh = (t_ms - _LAST_T[0]) / 3600000.0
        _CAP[0] += a * 1000 * dh
        _WH[0] += v * a * dh
    _LAST_T[0] = t_ms

    return {
        'vbus': round(v, 5), 'ibus': round(a, 5), 'pwr': round(v * a, 5),
        'cc1': round(cc1, 3), 'cc2': round(cc2, 3),
        'dp': round(dp, 3), 'dm': round(dm, 3),
        'temp': temp,
        'cap': round(_CAP[0], 2), 'wh': round(_WH[0], 4),
    }


# ══════════════════════════════════════════════════════════
#  3. WebSocket（标准库手写，单向推送够用）
# ══════════════════════════════════════════════════════════
WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def ws_frame(payload: bytes) -> bytes:
    n = len(payload)
    head = bytearray([0x81])
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126); head += struct.pack('>H', n)
    else:
        head.append(127); head += struct.pack('>Q', n)
    return bytes(head) + payload


class WS:
    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()
        self.alive = True

    def send(self, obj):
        if not self.alive:
            return
        try:
            data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            with self.lock:
                self.sock.sendall(ws_frame(data))
        except Exception:
            self.alive = False


# ══════════════════════════════════════════════════════════
#  4. HTTP + WebSocket 服务
# ══════════════════════════════════════════════════════════
class Handler(http.server.SimpleHTTPRequestHandler):
    clients = set()
    clients_lock = threading.Lock()
    state = {'device': {}, 'status': '初始化'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.split('?')[0] in ('/ws', '/websocket'):
            return self.upgrade()
        return super().do_GET()

    def upgrade(self):
        key = self.headers.get('Sec-WebSocket-Key')
        if not key:
            self.send_error(400); return
        accept = base64.b64encode(hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
        self.wfile.write((
            'HTTP/1.1 101 Switching Protocols\r\n'
            'Upgrade: websocket\r\n'
            'Connection: Upgrade\r\n'
            f'Sec-WebSocket-Accept: {accept}\r\n\r\n'
        ).encode())
        self.wfile.flush()
        ws = WS(self.connection)
        with Handler.clients_lock:
            Handler.clients.add(ws)
        print(f'[ws] 手机已连接，当前 {len(Handler.clients)} 个客户端')
        ws.send({'type': 'device', 'data': Handler.state['device'] or {'product': 'RK-X3'}})
        try:
            while ws.alive:
                time.sleep(1)
                # 嗅探断开
                try:
                    self.connection.setblocking(False)
                    d = self.connection.recv(1)
                    self.connection.setblocking(True)
                    if d == b'':
                        break
                except BlockingIOError:
                    pass
                except Exception:
                    break
        finally:
            ws.alive = False
            with Handler.clients_lock:
                Handler.clients.discard(ws)
            print(f'[ws] 客户端断开，剩 {len(Handler.clients)} 个')


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def broadcast(obj):
    with Handler.clients_lock:
        dead = [c for c in Handler.clients if not c.alive]
        for c in dead:
            Handler.clients.discard(c)
        for c in Handler.clients:
            c.send(obj)


# ══════════════════════════════════════════════════════════
#  5. 主流程
# ══════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='0.0.0.0')
    ap.add_argument('--no-serve', action='store_true', help='不托管网页，只开 WebSocket')
    ap.add_argument('--rate', type=float, default=20.0, help='推送给手机的帧率上限')
    args = ap.parse_args()

    path = find_device_path()
    if not path:
        print('✗ 没找到 RK-X3 功率表。')
        print(f'  请确认已用数据线接到电脑（USB HID 接口，VID {VID:04X}:PID {PID:04X}）。')
        sys.exit(2)
    info = read_strings(path)
    print(f'✓ 找到设备: {info.get("product")}  SN={info.get("serial")}  ({info.get("manufacturer")})')
    Handler.state['device'] = {
        'product': info.get('product', 'RK-X3'),
        'sn': info.get('serial', '—'),
        'version': Handler.state['device'].get('version', '—'),
    }

    last = [0.0]
    min_dt = 1.0 / max(1.0, args.rate)

    def on_frame(data, ts):
        if ts - last[0] < min_dt:
            return
        last[0] = ts
        f = decode(data)
        if os.environ.get('RYKEN_DEBUG'):
            print('[帧]', f if f else data.hex(' '), file=sys.stderr, flush=True)
        if f:
            f['t'] = int(ts * 1000)
            broadcast({'type': 'frame', 'data': f})
        else:
            broadcast({'type': 'raw', 'data': {'t': int(ts * 1000), 'hex': data.hex(' ')}})

    reader = HidReader(path, on_frame, on_status=lambda s: print('[设备]', s))
    reader.start()

    if args.no_serve:
        srv = ThreadingServer((args.host, args.port), Handler)
    else:
        srv = ThreadingServer((args.host, args.port), Handler)

    ips = local_ips()
    print()
    print('─' * 52)
    print(f'  WebSocket : ws://<电脑IP>:{args.port}/ws')
    if not args.no_serve:
        print('  手机访问  :')
        for ip in ips:
            print(f'     http://{ip}:{args.port}/')
    print('─' * 52)
    print('  协议：START(AA 0C) 开流 + 1Hz KEEPALIVE(AA 06) 续期，解码已启用。')
    print()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n退出')
        reader.running = False


def local_ips():
    import socket
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for a in socket.gethostbyname_ex(socket.gethostname())[2]:
            if a not in ips and not a.startswith('127.'):
                ips.append(a)
    except Exception:
        pass
    return ips or ['127.0.0.1']


if __name__ == '__main__':
    main()
