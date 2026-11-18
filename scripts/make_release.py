"""Assemble the distributable release folder: installer + portable zip + checksums."""
import hashlib
import shutil
import zipfile
from pathlib import Path

import json

ROOT = Path(r"D:\project\jieyi")
VERSION = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"]
NSIS = ROOT / "src-tauri/target/release/bundle/nsis"
EXE = ROOT / "src-tauri/target/release/jieyi.exe"
GUIDE = ROOT / "使用说明.txt"
OUT = ROOT / "dist-release"

OUT.mkdir(exist_ok=True)
# only refresh the artifacts, keep the hand-written release notes
INSTALLER_NAME = f"JieYi_{VERSION}_x64-setup.exe"
PORTABLE_NAME = f"JieYi-{VERSION}-portable-win64.zip"
for name in (INSTALLER_NAME, PORTABLE_NAME, "SHA256SUMS.txt"):
    target = OUT / name
    if target.exists():
        target.unlink()
# drop artifacts from older versions so the folder only ever holds one release
for stale in list(OUT.glob("JieYi_*_x64-setup.exe")) + list(OUT.glob("JieYi-*-portable-win64.zip")):
    if stale.name not in (INSTALLER_NAME, PORTABLE_NAME):
        stale.unlink()

# match the version explicitly: older installers stay in the bundle dir after upgrades
installer_src = next(NSIS.glob(f"*_{VERSION}_x64-setup.exe"))
installer = OUT / INSTALLER_NAME
shutil.copy2(installer_src, installer)

portable = OUT / PORTABLE_NAME
with zipfile.ZipFile(portable, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(EXE, "JieYi/jieyi.exe")
    z.write(GUIDE, "JieYi/使用说明.txt")

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

lines = []
# only the downloadable binaries: the notes live in the release body
for name in (INSTALLER_NAME, PORTABLE_NAME):
    p = OUT / name
    if not p.exists():
        continue
    size = p.stat().st_size / 1024 / 1024
    lines.append(f"{sha256(p)}  {p.name}  ({size:.2f} MB)")
(OUT / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

print("\n".join(lines))
