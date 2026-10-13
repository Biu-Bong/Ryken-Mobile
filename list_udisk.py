# -*- coding: utf-8 -*-
"""只读列举设备 U 盘（F: RKX3 / E: RKX3IAP）的文件树，验证离线记录与开机图是否真的在那里。"""
import os
import sys

ROOTS = ['F:\\', 'E:\\']
out = []
for root in ROOTS:
    if not os.path.exists(root):
        out.append(f'{root} 不存在')
        continue
    out.append(f'\n===== {root} =====')
    try:
        st = os.statvfs(root)
    except Exception:
        st = None
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        out.append(f'\n[{rel}]')
        for fn in sorted(filenames):
            p = os.path.join(dirpath, fn)
            try:
                sz = os.path.getsize(p)
                mt = os.path.getmtime(p)
                import time
                ts = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(mt))
            except Exception as e:
                sz, ts = -1, str(e)
            out.append(f'   {fn}   {sz:>10,} B   {ts}')
        if not dirnames and not filenames:
            out.append('   (空)')

txt = '\n'.join(out)
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'udisk.txt')
with open(p, 'w', encoding='utf-8') as f:
    f.write(txt)
print(txt)
