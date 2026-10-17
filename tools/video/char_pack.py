#!/usr/bin/env python3
"""形象包工具：把 videos/ 打成 zip、把 zip 安装回 videos/、查看包内容。

形象包 = 一个 zip，里面按状态名放视频（idle.webm / studying.mp4 / ...），
外加可选的 manifest.json（name/author/version/note）。应用内「更换形象」
直接导入这个 zip 即可切换；本脚本负责磁盘侧：

    pack     把 desktop-pet/videos/zhenzhu/ 打包到 desktop-pet/videos/<名字>.zip
    install  把 zip 解压进 videos/zhenzhu/（覆盖前自动备份到 videos/_backup_<日期>/）
    list     查看包里的 manifest 和状态视频

零第三方依赖，只用标准库。Windows 终端中文乱码时加 PYTHONIOENCODING=utf-8。

用法：
    python tools/video/char_pack.py pack
    python tools/video/char_pack.py pack --name "我的角色" --author 某人
    python tools/video/char_pack.py install 某个形象.zip
    python tools/video/char_pack.py list 某个形象.zip
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

STATES = ("idle", "studying", "working", "alert", "done", "refuse", "talking")
VIDEO_EXTS = (".webm", ".mp4")
DEFAULT_NAME = "默认形象-紫发少女"
VIDEOS_DIR = Path(__file__).resolve().parent.parent.parent / "desktop-pet" / "videos"
# 应用内置的默认形象目录（character/builtin.js 里的 dir）
DEFAULT_VIDEOS = VIDEOS_DIR / "zhenzhu"
MANIFEST_NAME = "manifest.json"
BAD_NAME_CHARS = re.compile(r'[\\/:*?"<>|]')


def state_name(name: str) -> str | None:
    """文件名（可带目录）-> 状态名，规则与 make_pet_videos.py 一致。"""
    stem = Path(name).stem.strip().lower()
    stem = re.sub(r"[\s-]+", "_", stem)
    return stem if stem in STATES else None


def safe_name(name: str) -> str:
    return BAD_NAME_CHARS.sub("_", name).strip() or "形象包"


def videos_dir(arg: str | None) -> Path:
    if arg:
        return Path(arg).resolve()
    return DEFAULT_VIDEOS


def read_manifest(zf: zipfile.ZipFile) -> dict | None:
    """找包内 manifest.json，取路径最浅的一个（外层只有一个目录时也能找到）。"""
    best = None
    best_depth = 10 ** 6
    for info in zf.infolist():
        if info.is_dir():
            continue
        if info.filename.rsplit("/", 1)[-1].lower() != MANIFEST_NAME:
            continue
        depth = info.filename.count("/")
        if depth < best_depth:
            best, best_depth = info, depth
    if best is None:
        return None
    try:
        data = json.loads(zf.read(best).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    out = {}
    for key in ("name", "author", "version", "note", "created"):
        val = data.get(key)
        if isinstance(val, (str, int, float)):
            out[key] = str(val)
    return out


def collect_videos(root: Path) -> list[tuple[str, str, Path]]:
    """按 STATES 顺序收集，每状态优先 .webm。返回 [(state, ext, path)]。"""
    found = []
    for state in STATES:
        for ext in VIDEO_EXTS:
            p = root / (state + ext)
            if p.is_file():
                found.append((state, ext, p))
                break
    return found


def cmd_pack(args: argparse.Namespace) -> int:
    root = videos_dir(args.videos)
    if not root.is_dir():
        raise SystemExit(f"videos 目录不存在：{root}")
    videos = collect_videos(root)
    if not videos:
        raise SystemExit(f"{root} 下没有可打包的状态视频（{'/'.join(STATES)}）")

    out_dir = Path(args.out).resolve() if args.out else VIDEOS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / (safe_name(args.name) + ".zip")

    manifest = {
        "name": args.name,
        "author": args.author,
        "version": args.version,
        "note": args.note,
        "created": datetime.now().strftime("%Y-%m-%d"),
    }
    method = zipfile.ZIP_STORED if args.method == "stored" else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(zip_path, "w", method) as zf:
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
        for state, ext, p in videos:
            zf.write(p, state + ext)
            print(f"  {state + ext:16s} {p.stat().st_size / 1024:8.0f} KB")
    size_kb = zip_path.stat().st_size / 1024
    print(f"\n已打包 {len(videos)}/{len(STATES)} 个状态视频 -> {zip_path}（{size_kb:.0f} KB）")
    if len(videos) < len(STATES):
        missing = [s for s in STATES if all(s != v[0] for v in videos)]
        print(f"提示：缺少状态 {', '.join(missing)}，应用里会用 idle 顶替。")
    print("应用内：双击 index.html -> 顶部「更换形象」-> 导入形象包。")
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    zip_path = Path(args.zip)
    if not zip_path.is_file():
        raise SystemExit(f"找不到形象包：{zip_path}")
    root = videos_dir(args.videos)
    root.mkdir(parents=True, exist_ok=True)

    plan: dict[str, tuple[zipfile.ZipInfo, str]] = {}
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            state = state_name(info.filename)
            if state is None:
                continue
            ext = Path(info.filename).suffix.lower()
            if ext not in VIDEO_EXTS:
                continue
            if state in plan:
                print(f"  跳过重复状态 {state}：{info.filename}")
                continue
            plan[state] = (info, ext)

    if not plan:
        raise SystemExit("包里没有找到可用的状态视频（文件名需为 idle/studying/... 等）")

    stamp = datetime.now().strftime("%Y%m%d")
    # 目标是 videos/ 下的角色目录时，备份放到 videos/ 下，别污染角色目录
    backup_parent = root.parent if root.parent == VIDEOS_DIR else root
    backup = backup_parent / ("_backup_" + stamp)
    if backup.exists():
        backup = backup_parent / ("_backup_" + stamp + "_" + datetime.now().strftime("%H%M%S"))

    to_backup = [root / (s + e) for s, (i, e) in plan.items() if (root / (s + e)).is_file()]
    if to_backup:
        backup.mkdir(parents=True, exist_ok=True)
        for p in to_backup:
            shutil.copy2(p, backup / p.name)
        print(f"已备份 {len(to_backup)} 个旧素材 -> {backup}")

    with zipfile.ZipFile(zip_path) as zf:
        for state in STATES:
            if state not in plan:
                continue
            info, ext = plan[state]
            target = root / (state + ext)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            print(f"  安装 {state + ext:16s} {info.file_size / 1024:8.0f} KB")

    missing = [s for s in STATES if s not in plan]
    print(f"\n已安装 {len(plan)}/{len(STATES)} 个状态视频到 {root}")
    if missing:
        print(f"提示：缺少状态 {', '.join(missing)}，应用里会用 idle 顶替。")
    print("刷新页面（Ctrl+F5）即可看到新形象。")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    zip_path = Path(args.zip)
    if not zip_path.is_file():
        raise SystemExit(f"找不到形象包：{zip_path}")
    with zipfile.ZipFile(zip_path) as zf:
        manifest = read_manifest(zf)
        print(f"形象包：{zip_path.name}（{zip_path.stat().st_size / 1024:.0f} KB）")
        if manifest:
            print("manifest：")
            for key in ("name", "author", "version", "note", "created"):
                if key in manifest:
                    print(f"  {key:8s} {manifest[key]}")
        else:
            print("manifest：无（应用会回退用 zip 文件名作形象名）")
        print("内容：")
        for info in zf.infolist():
            if info.is_dir():
                continue
            state = state_name(info.filename)
            tag = f"[{state}]" if state else "[忽略]"
            print(f"  {tag:8s} {info.filename:32s} {info.file_size / 1024:8.0f} KB")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="形象包工具：打包/安装/查看桌宠角色视频 zip",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("pack", help="把 videos/ 下的素材打包成 zip")
    p.add_argument("--name", default=DEFAULT_NAME, help="形象名，同时作为 zip 文件名")
    p.add_argument("--author", default="", help="作者")
    p.add_argument("--version", default="1.0", help="版本")
    p.add_argument("--note", default="", help="备注")
    p.add_argument("--out", help="输出目录，默认 desktop-pet/videos")
    p.add_argument("--method", choices=("stored", "deflated"), default="stored",
                   help="压缩方式；stored 兼容性最好（视频本身已压缩）")
    p.add_argument("--videos", help="素材目录，默认 desktop-pet/videos/zhenzhu")
    p.set_defaults(func=cmd_pack)

    i = sub.add_parser("install", help="把 zip 解压进 videos/（自动备份旧素材）")
    i.add_argument("zip", help="形象包路径")
    i.add_argument("--videos", help="目标目录，默认 desktop-pet/videos/zhenzhu")
    i.set_defaults(func=cmd_install)

    l = sub.add_parser("list", help="查看 zip 的 manifest 与状态视频")
    l.add_argument("zip", help="形象包路径")
    l.set_defaults(func=cmd_list)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
