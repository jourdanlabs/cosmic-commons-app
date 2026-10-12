#!/usr/bin/env python3
"""Package the local public source tree; no application or engine build occurs.
Copyright 2026 Leland Jourdan II / JourdanLabs · Apache-2.0
"""
from pathlib import Path
import hashlib
import json
import os
import stat
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / 'COMMONS-App-v1.0.2.zip'
if destination == root or root in destination.parents:
    raise SystemExit('Output must be outside the delivered source tree')
paths = []
for directory, names, files in os.walk(root, followlinks=False):
    names[:] = sorted(name for name in names if name not in {'.git', 'node_modules', 'data', '__pycache__'})
    for name in sorted(files):
        item = Path(directory) / name
        if item.is_symlink():
            raise SystemExit(f'Symlink refused: {item}')
        if name == '.DS_Store' or name.endswith(('.sqlite', '.sqlite-shm', '.sqlite-wal', '.pyc')):
            raise SystemExit(f'Workspace/cache file refused: {item}')
        if item.name != 'CHECKSUMS-APP.sha256':
            paths.append(item)
paths.sort(key=lambda p: p.relative_to(root).as_posix())
manifest = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(root).as_posix()}\n' for p in paths)
(root / 'CHECKSUMS-APP.sha256').write_text(manifest, encoding='utf-8')
paths.append(root / 'CHECKSUMS-APP.sha256')
destination.parent.mkdir(parents=True, exist_ok=True)
prefix = 'COMMONS-App-v1.0.2/'
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for item in sorted(paths, key=lambda p: p.relative_to(root).as_posix()):
        info = zipfile.ZipInfo(prefix + item.relative_to(root).as_posix(), (2026, 10, 8, 0, 0, 0))
        info.create_system = 3
        mode = stat.S_IFREG | (item.stat().st_mode & 0o777)
        info.external_attr = mode << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, item.read_bytes(), compresslevel=9)
with zipfile.ZipFile(destination) as archive:
    if archive.testzip() is not None:
        raise SystemExit('ZIP integrity failure')
print(json.dumps({'archive': str(destination), 'bytes': destination.stat().st_size,
                  'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
                  'files': len(paths)}, indent=2))
