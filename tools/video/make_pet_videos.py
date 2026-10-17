#!/usr/bin/env python3
"""把 AI 生成的视频批量转成 desktop-pet/videos/ 可用的 VP9-alpha WebM。

处理链路：抽帧 -> 去水印 -> 白底转透明 -> 编码 VP9-alpha -> 校验像素格式。

水印模板（assets/doubao_watermark.npz）按 720x720、豆包「豆包AI生成」
水印标定，模板里存的是带符号的 alpha（正值为白色水印，负值为投影/阴影）。
水印在不同片段里会出现在右下角或左上角，本脚本逐帧在候选位置做匹配滤波，
命中后按 alpha 只修补水印笔画占用的像素，不碰周围画面。

用法示例：
    python tools/video/make_pet_videos.py new_video --out new_video/processed
    python tools/video/make_pet_videos.py new_video --out desktop-pet/videos --crf 36

依赖：numpy、Pillow、scipy、opencv-python-headless、ffmpeg（见 README.md）。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage

STATES = ("idle", "studying", "working", "alert", "done", "refuse", "talking")
VIDEO_EXTS = (".mp4", ".webm", ".mov", ".mkv", ".avi")

# 720x720 基准下的水印候选位置（水印笔画左上角坐标的搜索窗口）
CANDIDATES = {
    "br": (586, 606, 664, 676),   # 右下角：x0, x1, y0, y1
    "tl": (14, 32, 11, 22),       # 左上角
}


def log(msg: str) -> None:
    print(msg, flush=True)


def find_ffmpeg(explicit: str | None) -> str:
    """按 参数 -> 环境变量 -> tools/video/ffmpeg.exe -> PATH -> imageio_ffmpeg 查找。"""
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return str(p)
        raise SystemExit(f"找不到 ffmpeg：{explicit}")

    env = os.environ.get("FFMPEG")
    if env and Path(env).is_file():
        return env

    local = Path(__file__).resolve().parent / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if local.is_file():
        return str(local)

    which = shutil.which("ffmpeg")
    if which:
        return which

    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass

    raise SystemExit(
        "找不到 ffmpeg。请把 ffmpeg 放到 tools/video/ffmpeg.exe，"
        "或加入 PATH，或用 --ffmpeg 指定路径。下载见 tools/video/README.md。"
    )


def state_name(path: Path) -> str | None:
    """视频文件名 -> 状态名。'studying .mp4' -> 'studying'。"""
    name = path.stem.strip().lower().replace(" ", "_")
    name = name.replace("-", "_")
    return name if name in STATES else None


def extract_frames(ffmpeg: str, src: Path, dst: Path, fps: int) -> int:
    dst.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src), "-vf", f"fps={fps}", "-an",
        str(dst / "%05d.png"),
    ]
    subprocess.run(cmd, check=True)
    return len(list(dst.glob("*.png")))


def load_watermark(path: Path) -> dict:
    data = np.load(path)
    alpha = data["alpha"].astype(np.float32)
    box = data["box"].astype(np.int32)
    ref = data["ref_glyph"].astype(np.int32)
    return {
        "alpha": alpha,
        "offset": (int(box[0] - ref[0]), int(box[1] - ref[1])),
    }


class WatermarkRemover:
    """匹配滤波定位 + 按 alpha 足迹局部修补。"""

    def __init__(self, asset: dict, high: float, low: float):
        self.alpha = asset["alpha"]
        self.off = asset["offset"]
        self.high = high
        self.low = low

        positive = np.maximum(self.alpha, 0)
        h, w = positive.shape
        pad = 12
        kernel = np.zeros((h + 2 * pad, w + 2 * pad), np.float32)
        kernel[pad:pad + h, pad:pad + w] = positive
        self._pad = pad
        inside = kernel.copy()
        ring = np.zeros_like(kernel)
        ring[:pad, :] = 1
        ring[-pad:, :] = 1
        ring[:, :pad] = 1
        ring[:, -pad:] = 1
        ring = ring - ring * kernel
        self.kernel = inside / inside.sum() - ring / ring.sum()
        self._cx = (w + 2 * pad) // 2
        self._cy = (h + 2 * pad) // 2

        # 修补足迹：正负 alpha 都算，外扩覆盖抗锯齿和阴影
        self.footprint = (np.abs(self.alpha) > 0.02).astype(np.uint8)
        self.footprint = cv2.dilate(self.footprint, np.ones((3, 3), np.uint8), 1)

    @staticmethod
    def _alpha_residual(bgr: np.ndarray) -> np.ndarray:
        """估计“比局部背景更白、且低饱和”的程度，抑制彩色高光。"""
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
        sat = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[:, :, 1].astype(np.float32)
        base = cv2.medianBlur(gray.astype(np.uint8), 25).astype(np.float32)
        return np.clip((gray - base) / (255.0 - base + 1e-3), 0, 1) * (1 - sat / 255.0)

    def _score_map(self, residual: np.ndarray) -> np.ndarray:
        return cv2.filter2D(residual, -1, self.kernel)

    def _local_best(self, score: np.ndarray, win: tuple[int, int, int, int]) -> tuple[float, int, int]:
        x0, x1, y0, y1 = win
        h, w = score.shape
        # 匹配滤波输出坐标 -> 水印笔画左上角坐标
        gx_off = self._pad - self.off[0]
        gy_off = self._pad - self.off[1]
        best = (-1e9, x0, y0)
        for gy in range(max(0, y0), min(h, y1 + 1)):
            for gx in range(max(0, x0), min(w, x1 + 1)):
                kx = gx + self._cx - gx_off
                ky = gy + self._cy - gy_off
                if 0 <= ky < score.shape[0] and 0 <= kx < score.shape[1]:
                    v = float(score[ky, kx])
                    if v > best[0]:
                        best = (v, gx, gy)
        return best

    def locate(self, bgr: np.ndarray) -> dict[str, tuple[float, int, int]]:
        score = self._score_map(self._alpha_residual(bgr))
        return {name: self._local_best(score, win) for name, win in CANDIDATES.items()}

    def segments(self, per_frame: dict[str, list[tuple[float, int, int]]]) -> dict[str, set[int]]:
        """高阈值定种子，低阈值向两侧延展，覆盖淡入淡出帧。"""
        out = {}
        for name, hits in per_frame.items():
            idx = set()
            n = len(hits)
            for i, (v, _, _) in enumerate(hits):
                if v < self.high:
                    continue
                idx.add(i)
                j = i - 1
                while j >= 0 and hits[j][0] >= self.low:
                    idx.add(j)
                    j -= 1
                j = i + 1
                while j < n and hits[j][0] >= self.low:
                    idx.add(j)
                    j += 1
            out[name] = idx
        return out

    def remove(self, bgr: np.ndarray, gx: int, gy: int) -> np.ndarray:
        full = np.zeros(bgr.shape[:2], np.uint8)
        H, W = full.shape
        x, y = gx + self.off[0], gy + self.off[1]
        h, w = self.footprint.shape
        x0d, y0d = max(0, x), max(0, y)
        x1d, y1d = min(x + w, W), min(y + h, H)
        if x1d <= x0d or y1d <= y0d:
            return bgr
        sx0, sy0 = x0d - x, y0d - y
        full[y0d:y1d, x0d:x1d] = self.footprint[
            sy0:sy0 + (y1d - y0d), sx0:sx0 + (x1d - x0d)
        ]
        return cv2.inpaint(bgr, full, 7, cv2.INPAINT_TELEA)


def remove_background(bgr: np.ndarray, tol: int, feather: float, erode: int = 1) -> np.ndarray:
    """白底转透明：只抠与画面四边连通的亮色背景，角色内部白色保留。"""
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    gray = rgb.mean(axis=2)
    cand = gray >= (255 - tol)
    lab, _ = ndimage.label(cand)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    bg = np.isin(lab, list(border)) if border else np.zeros_like(cand, bool)

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    solid = ndimage.binary_erosion(~bg, iterations=erode)
    soft = cv2.GaussianBlur((solid * 255).astype(np.uint8), (0, 0), feather)
    alpha = np.minimum(alpha, soft)
    return np.dstack([bgr, alpha])


def process_video(
    ffmpeg: str,
    src: Path,
    dst: Path,
    state: str,
    remover: WatermarkRemover | None,
    args: argparse.Namespace,
    work_root: Path,
) -> dict:
    work = work_root / state
    frames = work / "frames"
    if work.exists():
        shutil.rmtree(work)
    n = extract_frames(ffmpeg, src, frames, args.fps)
    if n == 0:
        raise RuntimeError(f"{src} 没抽出任何帧")

    paths = sorted(frames.glob("*.png"))
    hits: dict[str, list[tuple[float, int, int]]] = {"br": [], "tl": []}
    bgrs: list[np.ndarray] = []

    if remover:
        for p in paths:
            bgr = cv2.imread(str(p))
            if bgr is None:
                raise RuntimeError(f"读不了帧：{p}")
            bgrs.append(bgr)
            found = remover.locate(bgr)
            for key, val in found.items():
                hits[key].append(val)
        segs = remover.segments(hits)

    out_frames = work / "rgba"
    out_frames.mkdir(parents=True, exist_ok=True)
    for i, p in enumerate(paths):
        bgr = bgrs[i] if remover else cv2.imread(str(p))
        if bgr is None:
            raise RuntimeError(f"读不了帧：{p}")
        if remover:
            # 同一帧最多命中一处水印；两个候选都命中时都修
            for key, idx in segs.items():
                if i in idx:
                    _, gx, gy = hits[key][i]
                    bgr = remover.remove(bgr, gx, gy)
        if args.no_bg:
            rgba = np.dstack([bgr, np.full(bgr.shape[:2], 255, np.uint8)])
        else:
            rgba = remove_background(bgr, args.tol, args.feather)
        cv2.imwrite(str(out_frames / p.name), rgba)

    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", str(args.fps), "-start_number", "1",
        "-i", str(out_frames / "%05d.png"),
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-crf", str(args.crf), "-b:v", "0", "-auto-alt-ref", "0",
        "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-an",
        str(dst),
    ]
    subprocess.run(cmd, check=True)

    pix_fmt = probe_pix_fmt(ffmpeg, dst)
    alpha = probe_alpha(ffmpeg, dst)
    size_kb = dst.stat().st_size / 1024
    result = {
        "state": state,
        "src": src.name,
        "frames": n,
        "seconds": n / args.fps,
        "size_kb": size_kb,
        "pix_fmt": pix_fmt,
        "alpha": alpha,
        "watermarked_frames": sum(len(s) for s in segs.values()) if remover else 0,
    }
    if not args.keep_frames:
        shutil.rmtree(work)
    return result


def probe_pix_fmt(ffmpeg: str, path: Path) -> str:
    # 必须指定 libvpx-vp9 解码器：ffmpeg 内置 vp9 解码器不认 alpha，
    # 直接 -i 会误报成 yuv420p，让人以为透明通道丢了
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-c:v", "libvpx-vp9", "-i", str(path)],
        capture_output=True, text=True,
    )
    for line in proc.stderr.splitlines():
        if "Video:" in line:
            # 形如 "Video: vp9 (Profile 0), yuva420p(tv, progressive), 720x720"
            for fmt in ("yuva420p", "yuva444p", "yuv420p", "yuv444p", "yuv422p"):
                if fmt in line:
                    return fmt
            return line.split("Video:")[1].split(",")[0].strip()
    return "unknown"


def probe_alpha(ffmpeg: str, path: Path) -> dict | None:
    """真的解一帧出来看 alpha 分布，比只读元数据可靠。"""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9",
         "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        capture_output=True,
    )
    data = proc.stdout
    if len(data) < 4:
        return None
    a = np.frombuffer(data, np.uint8)[3::4]
    return {
        "min": int(a.min()),
        "max": int(a.max()),
        "transparent": float((a < 250).mean()),
    }


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(
        description="AI 视频 -> VP9-alpha WebM（去豆包水印 + 白底透明）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("input", type=Path, help="输入目录（或单个视频文件）")
    ap.add_argument("--out", type=Path, required=True, help="输出目录")
    ap.add_argument("--ffmpeg", help="ffmpeg 可执行文件路径")
    ap.add_argument("--fps", type=int, default=24, help="抽帧/编码帧率")
    ap.add_argument("--crf", type=int, default=34, help="VP9 质量（越大越小越糊）")
    ap.add_argument("--tol", type=int, default=32, help="白底容差 0-255，抠不干净调大")
    ap.add_argument("--feather", type=float, default=0.8, help="边缘羽化半径（像素）")
    ap.add_argument("--watermark", type=Path, default=here / "assets" / "doubao_watermark.npz",
                    help="水印 alpha 模板")
    ap.add_argument("--watermark-high", type=float, default=0.05, help="水印命中阈值")
    ap.add_argument("--watermark-low", type=float, default=0.02, help="淡入淡出延展阈值")
    ap.add_argument("--no-watermark", action="store_true", help="跳过去水印")
    ap.add_argument("--no-bg", action="store_true", help="跳过白底转透明")
    ap.add_argument("--keep-frames", action="store_true", help="保留中间帧")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg(args.ffmpeg)
    log(f"ffmpeg: {ffmpeg}")

    inputs: list[Path]
    if args.input.is_file():
        inputs = [args.input]
    elif args.input.is_dir():
        inputs = sorted(p for p in args.input.iterdir() if p.suffix.lower() in VIDEO_EXTS)
    else:
        raise SystemExit(f"输入不存在：{args.input}")
    if not inputs:
        raise SystemExit(f"{args.input} 下没有视频文件")

    remover = None
    if not args.no_watermark:
        if not args.watermark.is_file():
            raise SystemExit(f"找不到水印模板：{args.watermark}")
        remover = WatermarkRemover(
            load_watermark(args.watermark), args.watermark_high, args.watermark_low
        )

    args.out.mkdir(parents=True, exist_ok=True)
    work_root = Path(tempfile.mkdtemp(prefix="_pet_video_", dir=str(args.out)))
    results = []
    failed = []
    try:
        for src in inputs:
            state = state_name(src)
            if state is None:
                log(f"[跳过] {src.name}：文件名不是 {', '.join(STATES)} 之一")
                continue
            log(f"[处理] {src.name} -> {state}.webm")
            try:
                r = process_video(ffmpeg, src, args.out / f"{state}.webm", state,
                                  remover, args, work_root)
            except Exception as exc:  # noqa: BLE001
                failed.append((src.name, str(exc)))
                log(f"  [失败] {exc}")
                continue
            results.append(r)
            a = r["alpha"]
            alpha_txt = (f"alpha {a['min']}-{a['max']} 透明 {a['transparent']:.0%}"
                         if a else "alpha 无")
            log(f"  {r['frames']} 帧 / {r['seconds']:.2f}s / {r['size_kb']:.0f} KB / "
                f"{r['pix_fmt']} / {alpha_txt} / 去水印 {r['watermarked_frames']} 帧")
    finally:
        if not args.keep_frames:
            shutil.rmtree(work_root, ignore_errors=True)

    log("")
    log(f"完成 {len(results)} 个，失败 {len(failed)} 个，输出：{args.out}")
    bad = [r for r in results
           if r["pix_fmt"] not in ("yuva420p", "yuva444p")
           or not r["alpha"] or r["alpha"]["transparent"] < 0.01]
    if bad:
        log("警告：以下文件没有透明通道，检查 ffmpeg 是否支持 libvpx-vp9：")
        for r in bad:
            log(f"  {r['state']}.webm  pix_fmt={r['pix_fmt']}  alpha={r['alpha']}")
    for name, err in failed:
        log(f"  失败 {name}: {err}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
