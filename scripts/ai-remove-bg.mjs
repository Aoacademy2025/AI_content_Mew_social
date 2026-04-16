#!/usr/bin/env node
/**
 * AI Background Removal Script
 * Usage: node scripts/ai-remove-bg.mjs <rawDir> <alphaDir>
 *
 * 1. AI removes background from each frame
 * 2. Alpha threshold: avatar pixels → 100% opaque, bg → 100% transparent
 * 3. Saves clean transparent PNGs to alphaDir
 */

import fs from "fs";
import path from "path";
import { removeBackground } from "@imgly/background-removal-node";
import { PNG } from "pngjs";

const CONCURRENCY = 4; // process 4 frames in parallel
const ALPHA_THRESHOLD = 30; // alpha > 30 → 255, ≤ 30 → 0
const ERODE_RADIUS = 2; // erode mask by 2 pixels to remove worst green fringe pixels
const DESPILL_BAND = 4; // despill green from edge pixels up to 4 pixels inward

const [rawDir, alphaDir] = process.argv.slice(2);

if (!rawDir || !alphaDir) {
  console.error("Usage: node scripts/ai-remove-bg.mjs <rawDir> <alphaDir>");
  process.exit(1);
}

if (!fs.existsSync(rawDir)) {
  console.error(`rawDir not found: ${rawDir}`);
  process.exit(1);
}

fs.mkdirSync(alphaDir, { recursive: true });

/**
 * Erode (shrink) the alpha mask by `radius` pixels.
 * Removes outermost edge pixels which contain the most green contamination.
 * Uses 4-connected neighbors (up/down/left/right).
 */
function erodeMask(png, radius) {
  const w = png.width;
  const h = png.height;

  for (let pass = 0; pass < radius; pass++) {
    // Snapshot current alpha values for this pass
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      alpha[i] = png.data[i * 4 + 3];
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (alpha[i] === 0) continue; // already transparent

        // If any neighbor is transparent, this is an edge pixel → erode it
        const hasTransparent =
          (x > 0     && alpha[i - 1] === 0) ||
          (x < w - 1 && alpha[i + 1] === 0) ||
          (y > 0     && alpha[i - w] === 0) ||
          (y < h - 1 && alpha[i + w] === 0);

        if (hasTransparent) {
          png.data[i * 4 + 3] = 0; // make transparent
          // Also zero out RGB to prevent color bleeding
          png.data[i * 4 + 0] = 0;
          png.data[i * 4 + 1] = 0;
          png.data[i * 4 + 2] = 0;
        }
      }
    }
  }
}

/**
 * Despill green ONLY on edge pixels (within `bandWidth` of transparent edge).
 * Uses BFS to find distance from transparent edge, then caps green to max(R,B).
 * Strength fades from 100% at edge to 0% at bandWidth.
 * Interior pixels are untouched — natural avatar colors preserved.
 */
function despillEdgeBand(png, bandWidth) {
  const w = png.width;
  const h = png.height;
  const total = w * h;

  // BFS: calculate distance from transparent edge for each opaque pixel
  const dist = new Int32Array(total).fill(-1);
  const queue = [];

  // Seed: all transparent pixels are distance 0
  for (let i = 0; i < total; i++) {
    if (png.data[i * 4 + 3] === 0) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  // BFS outward from transparent pixels into opaque region
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const d = dist[i] + 1;
    if (d > bandWidth) continue;

    const x = i % w;
    const y = (i - x) / w;
    const neighbors = [];
    if (x > 0)     neighbors.push(i - 1);
    if (x < w - 1) neighbors.push(i + 1);
    if (y > 0)     neighbors.push(i - w);
    if (y < h - 1) neighbors.push(i + w);

    for (const ni of neighbors) {
      if (dist[ni] === -1 && png.data[ni * 4 + 3] === 255) {
        dist[ni] = d;
        queue.push(ni);
      }
    }
  }

  // Apply green despill to edge band pixels
  for (let i = 0; i < total; i++) {
    if (dist[i] <= 0 || dist[i] > bandWidth) continue; // skip transparent & interior

    const idx = i * 4;
    const r = png.data[idx];
    const g = png.data[idx + 1];
    const b = png.data[idx + 2];
    const maxRB = Math.max(r, b);

    if (g > maxRB) {
      // Strength: 100% at dist=1 (edge), fading to 0% at dist=bandWidth
      const strength = 1 - (dist[i] - 1) / bandWidth;
      png.data[idx + 1] = Math.round(g - (g - maxRB) * strength);
    }
  }
}

/** Remove background, then hard-threshold + erode + edge-despill */
async function processFrame(inputPath, outputPath) {
  // Step 1: AI background removal
  const inputBuf = fs.readFileSync(inputPath);
  const blob = new Blob([inputBuf], { type: "image/png" });
  const result = await removeBackground(blob, {
    model: "medium",
    output: { format: "image/png", quality: 0.9 },
  });
  const aiBuf = Buffer.from(await result.arrayBuffer());

  // Step 2: Hard-threshold alpha (avatar = 255, bg = 0)
  const png = PNG.sync.read(aiBuf);
  for (let i = 3; i < png.data.length; i += 4) {
    png.data[i] = png.data[i] > ALPHA_THRESHOLD ? 255 : 0;
  }

  // Step 3: Erode mask to remove green fringe edge pixels
  erodeMask(png, ERODE_RADIUS);

  // Step 4: Despill green ONLY on remaining edge pixels (interior untouched)
  despillEdgeBand(png, DESPILL_BAND);

  const cleanBuf = PNG.sync.write(png);
  fs.writeFileSync(outputPath, cleanBuf);
}

const frames = fs.readdirSync(rawDir).filter(f => f.endsWith(".png")).sort();
console.log(`[ai-bg] ${frames.length} frames to process`);

for (let i = 0; i < frames.length; i += CONCURRENCY) {
  const batch = frames.slice(i, i + CONCURRENCY);
  const batchNum = Math.floor(i / CONCURRENCY) + 1;
  const totalBatches = Math.ceil(frames.length / CONCURRENCY);
  console.log(`[ai-bg] batch ${batchNum}/${totalBatches}`);

  await Promise.all(
    batch.map((file) =>
      processFrame(path.join(rawDir, file), path.join(alphaDir, file))
    )
  );
}

console.log(`[ai-bg] done — ${frames.length} frames processed`);
