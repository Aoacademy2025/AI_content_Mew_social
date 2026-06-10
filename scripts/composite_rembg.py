# -*- coding: utf-8 -*-
#!/usr/bin/env python3
"""
Fast AI Background Removal using rembg Python API + multiprocessing.

Strategy:
  1. FFmpeg extracts avatar frames as PNG (downscaled to 512px for fast inference)
  2. Multiprocessing pool runs rembg on all frames in parallel
  3. FFmpeg composites alpha PNGs over BG video

Requirements:
    pip install rembg onnxruntime

Usage: python composite_rembg.py <avatar.mp4> <bg.mp4> <out.mp4> [model]
  model: u2net (default), isnet-general-use, silueta (fastest ~43MB)
"""
import sys
import subprocess
import shutil
import os
import tempfile
import time
from multiprocessing import Pool, cpu_count
from pathlib import Path


def _process_one(args):
    """Worker function - runs in separate process, one session per worker."""
    frame_path, alpha_path, model = args
    try:
        from rembg import remove, new_session
        from PIL import Image
        import io

        session = new_session(model)
        img = Image.open(frame_path)
        result = remove(img, session=session, post_process_mask=True)
        result.save(alpha_path, "PNG")
        return True
    except Exception as e:
        print(f"[rembg-worker] error {frame_path}: {e}", flush=True)
        return False


def composite(avatar_path: str, bg_path: str, out_path: str, model: str = "u2net"):
    from rembg import remove, new_session  # verify available
    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    tmpdir = tempfile.mkdtemp(prefix="rembg_")
    frames_dir = os.path.join(tmpdir, "frames")
    alpha_dir  = os.path.join(tmpdir, "alpha")
    os.makedirs(frames_dir)
    os.makedirs(alpha_dir)

    try:
        # Probe fps
        probe = subprocess.run(
            [ffmpeg, "-v", "error", "-i", avatar_path, "-f", "null", "-"],
            capture_output=True, text=True
        )
        import re
        fps = 30.0
        m = re.search(r"(\d+(?:\.\d+)?)\s*(?:fps|tbr)", probe.stderr)
        if m:
            fps = float(m.group(1))
        print(f"[rembg] fps={fps} model={model}", flush=True)

        # Step 1: Extract frames downscaled to 512px wide
        t0 = time.time()
        print("[rembg] extracting frames...", flush=True)
        subprocess.run([
            ffmpeg, "-y", "-i", avatar_path,
            "-vf", "scale=512:-2:flags=bilinear",
            os.path.join(frames_dir, "frame_%06d.png"),
        ], check=True, capture_output=True)

        frame_files = sorted(Path(frames_dir).glob("frame_*.png"))
        total = len(frame_files)
        print(f"[rembg] {total} frames extracted in {time.time()-t0:.1f}s", flush=True)

        # Step 2: Parallel rembg using multiprocessing
        # Use min(cpu_count, 4) workers - more than 4 doesn't help much for ONNX
        workers = min(cpu_count(), 4)
        print(f"[rembg] running AI removal with {workers} workers...", flush=True)
        t1 = time.time()

        tasks = [
            (str(f), os.path.join(alpha_dir, f.name), model)
            for f in frame_files
        ]

        with Pool(processes=workers) as pool:
            done = 0
            for result in pool.imap(_process_one, tasks, chunksize=2):
                done += 1
                if done % 30 == 0 or done == total:
                    elapsed = time.time() - t1
                    fps_ai = done / elapsed if elapsed > 0 else 0
                    eta = (total - done) / fps_ai if fps_ai > 0 else 0
                    print(f"[rembg] {done}/{total}  {fps_ai:.1f} fps  ETA {eta:.0f}s", flush=True)

        ai_time = time.time() - t1
        print(f"[rembg] AI done in {ai_time:.1f}s ({total/ai_time:.1f} fps)", flush=True)

        # Step 3: Composite with FFmpeg
        print("[rembg] compositing...", flush=True)
        t2 = time.time()
        alpha_pattern = os.path.join(alpha_dir, "frame_%06d.png")

        subprocess.run([
            ffmpeg, "-y",
            "-stream_loop", "-1", "-i", bg_path,
            "-framerate", str(fps), "-i", alpha_pattern,
            "-i", avatar_path,
            "-filter_complex",
            "[0:v]scale=1080:1920:flags=bilinear,setsar=1[bg];"
            "[1:v]scale=1080:1920:flags=bilinear[fg];"
            "[bg][fg]overlay=0:0:format=auto[out]",
            "-map", "[out]", "-map", "2:a?",
            "-frames:v", str(total),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
            "-threads", "0",
            "-c:a", "aac", "-b:a", "128k",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            out_path,
        ], check=True)

        total_time = time.time() - t0
        print(f"[rembg] done in {total_time:.1f}s -> {out_path}", flush=True)

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: composite_rembg.py <avatar.mp4> <bg.mp4> <out.mp4> [model]")
        sys.exit(1)
    model_name = sys.argv[4] if len(sys.argv) > 4 else "u2net"
    composite(sys.argv[1], sys.argv[2], sys.argv[3], model_name)
