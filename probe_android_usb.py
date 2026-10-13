# -*- coding: utf-8 -*-
"""通过无线 adb 采集 Android 侧的 USB / MSC / 挂载状态。

用途：验证"功率表进 IAP(U盘模式) 后，手机能否挂载并写入"。

用法：
    python probe_android_usb.py            # 采一次
    python probe_android_usb.py 标签        # 带标签
    python probe_android_usb.py --watch 90  # 每 3 秒采一次，共 90 秒

关掉 adb server 的命令不在本脚本范围（只读探测，不做任何写操作）。
"""
import subprocess
import sys
import time

SN = '192.168.0.120:5555'


def sh(cmd, timeout=25):
    try:
        r = subprocess.run(['adb', '-s', SN, 'shell', cmd],
                           capture_output=True, text=True, timeout=timeout,
                           encoding='utf-8', errors='replace')
        return (r.stdout or '').strip()
    except Exception as e:
        return f'<ERR {type(e).__name__}: {e}>'


def snapshot(tag=''):
    print(f'===== {tag}  {time.strftime("%H:%M:%S")} =====')

    usb = sh('ls /sys/bus/usb/devices/')
    nodes = usb.split()
    leaf = [n for n in nodes if '-' in n.split(':')[0] and n.count(':') == 0]
    print(f'[USB]   全部节点 {nodes}')
    print(f'[USB]   外接设备 {leaf if leaf else "无"}')

    scsi = sh('ls /sys/bus/scsi/devices/')
    # ⚠ 手机内置 UFS 也会出现在这里，形如 0:0:0:N / hostN / targetN:N:N —— 全部排除
    ext = [x for x in scsi.split()
           if not x.startswith('0:0:0:') and not x.startswith('host') and not x.startswith('target')]
    print(f'[SCSI]  外接 USB 存储 {ext if ext else "无"}')

    mnts = sh('cat /proc/mounts')
    ext_v = [l for l in mnts.splitlines()
             if any(k in l for k in ('vfat', 'exfat', 'ntfs', 'fuseblk'))
             and not any(k in l for k in ('firmware', 'logfs', 'bt_firmware'))]
    print(f'[MOUNT] 外部卷 {ext_v if ext_v else "无"}')

    stor = sh('ls /storage/')
    print(f'[STOR]  /storage/ = {stor.split()}')

    mrw = sh('ls /mnt/media_rw/')
    print(f'[STOR]  /mnt/media_rw/ = {mrw.split() if mrw else "（空/不存在）"}')

    # vold 管理的卷才是"可挂载的外接存储"；/dev/block/sd* 在 UFS 机型上是内置分区，别用
    vold = sh('ls -l /dev/block/vold/ 2>/dev/null')
    print(f'[VOL]   /dev/block/vold/ = {vold.splitlines() if vold else "无（没有可挂载的外接卷）"}')

    dev = sh('ls -l /dev/bus/usb/001/')
    names = [l.split()[-1] for l in dev.splitlines() if l.strip() and not l.startswith('total')]
    print(f'[DEVBUS] /dev/bus/usb/001/ = {names}')
    print()


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--watch':
        total = int(args[1]) if len(args) > 1 else 90
        t0 = time.time()
        i = 0
        while time.time() - t0 < total:
            i += 1
            snapshot(f'采样 {i}')
            time.sleep(3)
    else:
        snapshot(args[0] if args else '当前状态')
