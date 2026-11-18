"""Build the "with resource pack" portable bundle (app + offline models).

    python scripts/make_offline_bundle.py [--models DIR] [--packs vlm,ocr]

The plain installer / portable zip stay small (the app downloads packs on
demand). This script produces the all-in-one variant: unpack it anywhere and
translation works with the network unplugged.

GitHub limits a single release asset to 2 GiB, so archives larger than that are
split into `.001`, `.002` … parts (join with `copy /b` on Windows or `cat` on
Unix).
"""
import argparse
import json
import os
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONF = ROOT / "src-tauri" / "tauri.conf.json"
DIST = ROOT / "dist-release"
APP_DATA = pathlib.Path(os.environ.get("APPDATA", pathlib.Path.home())) / "app.jieyi.desktop"
SPLIT_AT = 1_800_000_000  # stay under GitHub's 2 GiB asset limit


def human(n: float) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=str(APP_DATA / "models"), help="source models dir")
    ap.add_argument("--packs", default="runtime,vlm,ocr", help="comma separated pack ids")
    args = ap.parse_args()

    version = json.loads(CONF.read_text(encoding="utf-8"))["version"]
    models_src = pathlib.Path(args.models)
    wanted = [p.strip() for p in args.packs.split(",") if p.strip()]

    missing = [p for p in wanted if not (models_src / p).exists()]
    if missing:
        print("missing packs:", ", ".join(missing))
        print("download them first: 设置 → 模型服务 → 本地离线 → 下载，或用 scripts/ 里的 fetch 脚本")
        return 1

    # the app itself: reuse the portable zip the release script already built
    portable = DIST / f"JieYi-{version}-portable-win64.zip"
    if not portable.exists():
        print(f"run scripts/make_release.py first ({portable.name} missing)")
        return 1

    stage = DIST / f"_bundle-{version}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    with zipfile.ZipFile(portable) as z:
        z.extractall(stage)

    total = 0
    for pack in wanted:
        src = models_src / pack
        dst = stage / "models" / pack
        shutil.copytree(src, dst)
        size = sum(f.stat().st_size for f in src.rglob("*") if f.is_file())
        total += size
        print(f"  + models/{pack}  {human(size)}")

    out = DIST / f"JieYi-{version}-offline-win64.zip"
    print(f"zipping → {out.name} …")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for f in stage.rglob("*"):
            if f.is_file():
                z.write(f, f.relative_to(stage))
    shutil.rmtree(stage)

    size = out.stat().st_size
    print(f"built {out.name}  {human(size)}")
    if size > SPLIT_AT:
        parts = []
        with open(out, "rb") as f:
            i = 1
            while True:
                chunk = f.read(SPLIT_AT)
                if not chunk:
                    break
                part = out.with_suffix(out.suffix + f".{i:03d}")
                part.write_bytes(chunk)
                parts.append(part)
                i += 1
        out.unlink()
        print(f"split into {len(parts)} parts (GitHub 2 GB limit):")
        for p in parts:
            print(f"  {p.name}  {human(p.stat().st_size)}")
        print("join:  copy /b " + " + ".join(p.name for p in parts) + f" {out.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
