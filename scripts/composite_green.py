#!/usr/bin/env python3
"""
OpenCV green-screen composite — v2 (tighter chroma key + edge refinement)

Changes from v1:
  - similarity=0.20: tighter hue range (±12 instead of ±18) → less false-removal
  - erosion before dilate: shrink mask inward first to remove fringe pixels
  - Laplacian edge-aware alpha feathering: soft edges without halo
  - stronger spill suppression with luminance-weighted blend
  - Saturation floor raised 80→100 so light-green reflections on skin aren't keyed

Usage: python composite_green.py <avatar.mp4> <bg.mp4> <out.mp4>
"""
import sys, subprocess, shutil
import cv2
import numpy as np


def analyse_green(frame_bgr: np.ndarray):
    """Detect dominant green hue from corners + center sample."""
    h, w = frame_bgr.shape[:2]
    patches = [
        frame_bgr[0:40, 0:40],
        frame_bgr[0:40, w-40:w],
        frame_bgr[h-40:h, 0:40],
        frame_bgr[h-40:h, w-40:w],
        frame_bgr[h//2-20:h//2+20, w//2-20:w//2+20],  # center sample
    ]
    sample = np.vstack([p.reshape(-1, 3) for p in patches]).astype(np.uint8)
    hsv_sample = cv2.cvtColor(sample.reshape(1, -1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3)

    # Use median of high-saturation pixels only (ignore near-white/near-black)
    sat_mask = hsv_sample[:, 1] > 80
    if sat_mask.sum() > 10:
        hues = hsv_sample[sat_mask, 0].astype(float)
    else:
        hues = hsv_sample[:, 0].astype(float)

    hue = float(np.median(hues))
    # Tighter range: ±12 instead of ±18  →  similarity ≈ 0.20
    hue_lo = max(0,   int(hue - 12))
    hue_hi = min(180, int(hue + 12))
    print(f"[chroma] median hue={hue:.1f}  range=[{hue_lo}-{hue_hi}]", flush=True)
    return hue_lo, hue_hi


def build_mask(frame_bgr: np.ndarray, hue_lo: int, hue_hi: int) -> np.ndarray:
    """
    Build an 8-bit alpha mask where 255=background (green), 0=foreground (person).
    Uses erosion→dilate (not close) to pull the mask *inward* first, removing fringe.
    """
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)

    # Primary green mask — saturation floor 100 to ignore light skin reflections
    lower = np.array([hue_lo, 100, 60],  dtype=np.uint8)
    upper = np.array([hue_hi, 255, 255], dtype=np.uint8)
    mask = cv2.inRange(hsv, lower, upper)

    k3 = np.ones((3, 3), np.uint8)
    k5 = np.ones((5, 5), np.uint8)

    # Step 1: erode to pull mask inward — removes fringe / hair artifacts
    mask = cv2.erode(mask, k3, iterations=1)

    # Step 2: dilate slightly to recover clean BG areas
    mask = cv2.dilate(mask, k3, iterations=2)

    # Step 3: morphological close to fill small holes in BG
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k5, iterations=1)

    # Step 4: smooth edge for feathering (not too much to preserve sharpness)
    mask = cv2.GaussianBlur(mask, (7, 7), 0)

    return mask


def edge_feather(mask: np.ndarray, frame_bgr: np.ndarray) -> np.ndarray:
    """
    Refine alpha using edge information from the original frame.
    Pixels near strong edges get alpha set to 0 (keep foreground) to avoid
    eating into fine details like hair.
    """
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    # Laplacian detects fine edges (hair strands, etc.)
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    edge = np.abs(lap).astype(np.float32)
    edge = cv2.GaussianBlur(edge, (5, 5), 0)
    # Normalize to [0,1]
    if edge.max() > 0:
        edge = edge / edge.max()
    # Where strong edges exist AND mask is transitioning → reduce alpha (keep FG)
    edge_weight = (edge * 255).astype(np.uint8)
    # Only apply in the edge zone (mask 30-220 = transition zone)
    transition = (mask > 30) & (mask < 220)
    mask_f = mask.astype(np.float32)
    # Pull alpha toward 0 (FG) proportional to edge strength in transition zone
    reduction = edge * 180.0  # max 180 reduction
    mask_f[transition] = np.clip(mask_f[transition] - reduction[transition], 0, 255)
    return mask_f.astype(np.uint8)


def suppress_spill(frame_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """
    Green-spill suppression: replace excess green channel with average of R+B.
    Weighted by mask (only suppress where the mask says 'near green').
    """
    f = frame_bgr.astype(np.float32)
    b, g, r = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    avg_rb = (r + b) / 2.0
    # Spill weight — stronger near the BG (mask bright), gentle near FG edge
    w = (mask.astype(np.float32) / 255.0) ** 0.5  # gamma 0.5 → gentler falloff
    # Only suppress when green is actually above average of R+B by 10%
    is_spill = g > (avg_rb * 1.10)
    g_suppressed = np.where(is_spill, avg_rb * 1.02, g)  # slight +2% to avoid dark fringe
    g_out = g * (1.0 - w * 0.85) + g_suppressed * (w * 0.85)
    out = np.stack([b, g_out, r], axis=2).clip(0, 255).astype(np.uint8)
    return out


def composite(avatar_path: str, bg_path: str, out_path: str):
    av_cap = cv2.VideoCapture(avatar_path)
    bg_cap = cv2.VideoCapture(bg_path)

    av_fps   = av_cap.get(cv2.CAP_PROP_FPS) or 25.0
    bg_fps   = bg_cap.get(cv2.CAP_PROP_FPS) or 30.0
    av_w     = int(av_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    av_h     = int(av_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    bg_total = int(bg_cap.get(cv2.CAP_PROP_FRAME_COUNT))
    av_total = int(av_cap.get(cv2.CAP_PROP_FRAME_COUNT))

    print(f"[composite] avatar {av_w}x{av_h} @{av_fps}fps  bg @{bg_fps}fps  frames={av_total}", flush=True)

    # Analyse green from first frame
    ok, first_frame = av_cap.read()
    if not ok:
        raise RuntimeError("Cannot read avatar frame")
    hue_lo, hue_hi = analyse_green(first_frame)
    av_cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    # Launch ffmpeg: raw BGR from stdin + audio from avatar
    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{av_w}x{av_h}",
        "-pix_fmt", "bgr24",
        "-r", str(av_fps),
        "-i", "pipe:0",
        "-i", avatar_path,
        "-map", "0:v", "-map", "1:a?",
        "-c:v", "libx264", "-preset", "fast", "-crf", "17",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    av_idx = 0
    try:
        while True:
            ok_av, av_frame = av_cap.read()
            if not ok_av:
                break

            # Sync BG frame to avatar time (loop BG if shorter)
            bg_idx = int(av_idx * (bg_fps / av_fps)) % max(bg_total, 1)
            bg_cap.set(cv2.CAP_PROP_POS_FRAMES, bg_idx)
            ok_bg, bg_frame = bg_cap.read()
            if not ok_bg:
                bg_cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                _, bg_frame = bg_cap.read()
            if bg_frame is None:
                break

            # Resize BG to match avatar dimensions if needed
            if bg_frame.shape[1] != av_w or bg_frame.shape[0] != av_h:
                bg_frame = cv2.resize(bg_frame, (av_w, av_h))

            # Build chroma key mask
            mask = build_mask(av_frame, hue_lo, hue_hi)
            # Edge-aware refinement (preserves hair)
            mask = edge_feather(mask, av_frame)
            # Spill suppression
            av_clean = suppress_spill(av_frame, mask)

            # Alpha composite: BG where mask=255, FG where mask=0
            alpha3 = np.stack([mask.astype(np.float32) / 255.0] * 3, axis=2)
            comp = (
                bg_frame.astype(np.float32) * alpha3
                + av_clean.astype(np.float32) * (1.0 - alpha3)
            ).clip(0, 255).astype(np.uint8)

            proc.stdin.write(comp.tobytes())
            av_idx += 1

            if av_idx % 100 == 0:
                print(f"[composite] frame {av_idx}/{av_total}", flush=True)

    finally:
        av_cap.release()
        bg_cap.release()
        try:
            proc.stdin.close()
        except Exception:
            pass

    _, stderr = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{stderr.decode(errors='replace')[-1000:]}")

    print(f"[composite] done → {out_path} ({av_idx} frames)", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: composite_green.py <avatar.mp4> <bg.mp4> <out.mp4>")
        sys.exit(1)
    composite(sys.argv[1], sys.argv[2], sys.argv[3])
