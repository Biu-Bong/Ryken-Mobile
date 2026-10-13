# -*- coding: utf-8 -*-
"""枚举当前所有 HID 接口设备（VID/PID + 厂商/产品串），用于确认 IAP 模式下设备变成什么。"""
import ctypes as C
from ctypes import wintypes

setupapi = C.WinDLL('setupapi')
hid = C.WinDLL('hid')
k32 = C.WinDLL('kernel32')


class GUID(C.Structure):
    _fields_ = [("D1", C.c_ulong), ("D2", C.c_ushort), ("D3", C.c_ushort), ("D4", C.c_ubyte * 8)]


HID_GUID = GUID(0x4D1E55B2, 0xF16F, 0x11CF, (C.c_ubyte * 8)(0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30))


class DID(C.Structure):
    _fields_ = [("cbSize", C.c_ulong), ("g", GUID), ("Flags", C.c_ulong), ("Reserved", C.c_void_p)]


setupapi.SetupDiGetClassDevsW.restype = C.c_void_p
setupapi.SetupDiGetClassDevsW.argtypes = [C.POINTER(GUID), C.c_wchar_p, C.c_void_p, C.c_ulong]
setupapi.SetupDiEnumDeviceInterfaces.argtypes = [C.c_void_p, C.c_void_p, C.POINTER(GUID), C.c_ulong, C.c_void_p]
setupapi.SetupDiGetDeviceInterfaceDetailW.argtypes = [
    C.c_void_p, C.c_void_p, C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.c_void_p]
k32.CreateFileW.restype = C.c_void_p
k32.CreateFileW.argtypes = [C.c_wchar_p, C.c_ulong, C.c_ulong, C.c_void_p, C.c_ulong, C.c_ulong, C.c_void_p]
hid.HidD_GetManufacturerString.argtypes = [C.c_void_p, C.c_void_p, C.c_ulong]
hid.HidD_GetProductString.argtypes = [C.c_void_p, C.c_void_p, C.c_ulong]
hid.HidD_GetSerialNumberString.argtypes = [C.c_void_p, C.c_void_p, C.c_ulong]
hid.HidD_GetPreparsedData.argtypes = [C.c_void_p, C.POINTER(C.c_void_p)]
hid.HidD_GetAttributes.argtypes = [C.c_void_p, C.c_void_p]


class ATTR(C.Structure):
    _fields_ = [('Size', C.c_ulong), ('VendorID', C.c_ushort), ('ProductID', C.c_ushort), ('VersionNumber', C.c_ushort)]


def enum_paths():
    h = setupapi.SetupDiGetClassDevsW(C.byref(HID_GUID), None, None, 0x02 | 0x10)
    if not h:
        return []
    out = []
    i = 0
    d = DID(); d.cbSize = C.sizeof(DID)
    while True:
        n = C.c_ulong(0)
        if not setupapi.SetupDiEnumDeviceInterfaces(C.c_void_p(h), None, C.byref(HID_GUID), i, C.byref(d)):
            break
        i += 1
        need = C.c_ulong(0)
        setupapi.SetupDiGetDeviceInterfaceDetailW(C.c_void_p(h), C.byref(d), None, 0, C.byref(need), None)
        buf = C.create_string_buffer(need.value)
        C.cast(buf, C.POINTER(C.c_ulong))[0] = 8      # 64 位下 cbSize = 8
        if not setupapi.SetupDiGetDeviceInterfaceDetailW(C.c_void_p(h), C.byref(d), buf, need.value,
                                                         C.byref(need), None):
            continue
        path = C.cast(C.addressof(buf) + C.sizeof(C.c_ulong), C.c_wchar_p).value
        if path:
            out.append(path)
    return out


def info(path):
    r = {'path': path}
    import re
    m = re.search(r'vid_([0-9a-fA-F]{4})', path)
    m2 = re.search(r'pid_([0-9a-fA-F]{4})', path)
    r['vid'] = int(m.group(1), 16) if m else None
    r['pid'] = int(m2.group(1), 16) if m2 else None
    h = k32.CreateFileW(path, 0, 3, None, 3, 0, None)
    if h:
        a = ATTR(); a.Size = C.sizeof(ATTR)
        if hid.HidD_GetAttributes(C.c_void_p(h), C.byref(a)):
            r['vid'], r['pid'] = a.VendorID, a.ProductID
        for fn, key in ((hid.HidD_GetManufacturerString, 'manufacturer'),
                        (hid.HidD_GetProductString, 'product'),
                        (hid.HidD_GetSerialNumberString, 'serial')):
            b = C.create_unicode_buffer(128)
            if fn(C.c_void_p(h), b, 128):
                r[key] = b.value
        k32.CloseHandle(C.c_void_p(h))
    return r


if __name__ == '__main__':
    seen = {}
    for p in enum_paths():
        d = info(p)
        key = (d.get('vid'), d.get('pid'))
        seen.setdefault(key, []).append(d)
    print(f'HID 接口共 {len(seen)} 种 VID:PID\n')
    for (v, p_), lst in sorted(seen.items(), key=lambda kv: (kv[0][0] or 0, kv[0][1] or 0)):
        d = lst[0]
        print(f'VID {v:04X}  PID {p_:04X}   x{len(lst)}   '
              f'{d.get("manufacturer","")!r} / {d.get("product","")!r} / {d.get("serial","")!r}')
