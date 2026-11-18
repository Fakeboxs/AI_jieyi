"""Assemble the distributable release folder: installer + portable zip + checksums."""
import hashlib
import shutil
import zipfile
from pathlib import Path

ROOT = Path(r"D:\project\jieyi")
NSIS = ROOT / "src-tauri/target/release/bundle/nsis"
EXE = ROOT / "src-tauri/target/release/jieyi.exe"
GUIDE = ROOT / "使用说明.txt"
OUT = ROOT / "dist-release"

OUT.mkdir(exist_ok=True)
# only refresh the artifacts, keep the hand-written release notes
for name in ("JieYi_0.1.0_x64-setup.exe", "JieYi-0.1.0-portable-win64.zip", "SHA256SUMS.txt"):
    target = OUT / name
    if target.exists():
        target.unlink()

installer_src = next(NSIS.glob("*.exe"))
installer = OUT / "JieYi_0.1.0_x64-setup.exe"
shutil.copy2(installer_src, installer)

portable = OUT / "JieYi-0.1.0-portable-win64.zip"
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
for name in ("JieYi_0.1.0_x64-setup.exe", "JieYi-0.1.0-portable-win64.zip"):
    p = OUT / name
    if not p.exists():
        continue
    size = p.stat().st_size / 1024 / 1024
    lines.append(f"{sha256(p)}  {p.name}  ({size:.2f} MB)")
(OUT / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

print("\n".join(lines))
