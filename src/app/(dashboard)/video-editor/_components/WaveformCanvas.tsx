import { useEffect, useRef } from "react";

/** Draws a peak array (0..1) as a centered vertical-bar waveform. Renders nothing
 * when there are no peaks — the timeline simply shows no waveform (fail-safe). */
export function WaveformCanvas({ peaks, width, height, color = "rgba(139,124,246,0.40)" }: {
  peaks: number[] | null;
  width: number;
  height: number;
  color?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !peaks?.length || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.floor(width * dpr));
    cv.height = Math.max(1, Math.floor(height * dpr));
    const c = cv.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, cv.width, cv.height);
    c.fillStyle = color;
    const mid = cv.height / 2;
    const bw = cv.width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const h = Math.max(1, peaks[i] * cv.height);
      c.fillRect(i * bw, mid - h / 2, Math.max(1, bw * 0.8), h);
    }
  }, [peaks, width, height, color]);

  if (!peaks?.length) return null;
  return <canvas ref={ref} style={{ width, height, display: "block" }} aria-hidden />;
}
