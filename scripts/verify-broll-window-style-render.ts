// EP5 #11 + U3 real Remotion proof: renders the production ShortVideoComposition (the real
// Remotion root) over tiny local solid-colour fixtures and reads pixels back.
//  - dissolve (default) blends two windows at their boundary; "cut" shows only the next one;
//    the config-level `brollTransition` applies to every window without its own value and a
//    window's own value overrides it.
//  - the default ends on the 0.4 s fade to black; a last window set to "cut" does not.
//  - fit "contain" shows the whole 16:9 picture with darkened, blurred bands above and below;
//    the default "cover" fills the frame.
// No paid provider, no network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import sharp from "sharp";

const FPS = 30;
const WIDTH = 270;
const HEIGHT = 480;
const DURATION_FRAMES = 90; // 3 windows x 1 s

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${result.stderr.toString().slice(-600)}`);
}

function serve(dir: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    const file = path.join(dir, name);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Access-Control-Allow-Origin": "*" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Rgb = { r: number; g: number; b: number };

async function pixel(file: string, x: number, y: number): Promise<Rgb> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "broll-window-style-"));
  let server: http.Server | null = null;
  let serveUrl: string | null = null;
  try {
    // 16:9 solid clips, longer than any window so no loop/repair is involved.
    for (const [name, colour] of [["red", "0xE03030"], ["blue", "0x3040E0"]] as const) {
      ffmpeg([
        "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=${FPS}:d=4`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(work, `${name}.mp4`),
      ]);
    }
    server = await serve(work);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    serveUrl = await bundle({
      entryPoint: path.resolve("src/remotion/index.tsx"),
      publicDir: path.resolve("public"),
      webpackOverride: (config) => config,
    });

    const window = (src: string, start: number, extra: Record<string, unknown> = {}) => ({
      src: `${base}/${src}.mp4`, start, end: start + 1, clipDuration: 4, clipOffset: 0, sourceIndex: start, ...extra,
    });
    const still = async (name: string, config: Record<string, unknown>, frame: number) => {
      const inputProps = {
        keywordPopups: [], voiceFile: "", voiceVolume: 1, durationInFrames: DURATION_FRAMES, ...config,
      };
      const composition = await selectComposition({ serveUrl: serveUrl!, id: "ShortVideoComposition", inputProps });
      const output = path.join(work, `${name}-${frame}.png`);
      await renderStill({
        composition: { ...composition, width: WIDTH, height: HEIGHT, durationInFrames: DURATION_FRAMES },
        serveUrl: serveUrl!,
        output,
        frame,
        inputProps,
        imageFormat: "png",
        logLevel: "error",
      });
      return output;
    };
    const centre = (file: string) => pixel(file, WIDTH / 2, HEIGHT / 2);
    const top = (file: string) => pixel(file, WIDTH / 2, 20);
    // Boundary red -> blue at frame 30; frame 33 sits inside the 8-frame dissolve.
    const BOUNDARY_FRAME = 33;
    const blended = (c: Rgb) => c.r > 60 && c.b > 60;
    const pureBlue = (c: Rgb) => c.b > 120 && c.r < 70;

    const legacy = { bgVideos: [window("red", 0), window("blue", 1), window("red", 2)] };
    const dissolve = await centre(await still("legacy", legacy, BOUNDARY_FRAME));
    console.log(`  default boundary pixel ${JSON.stringify(dissolve)}`);
    assert.ok(blended(dissolve), "default: windows dissolve into each other");
    console.log("✓ default (no field anywhere) keeps today's dissolve");

    const cut = await centre(await still("cut", {
      bgVideos: [window("red", 0, { transition: "cut" }), window("blue", 1), window("red", 2)],
    }, BOUNDARY_FRAME));
    console.log(`  cut boundary pixel ${JSON.stringify(cut)}`);
    assert.ok(pureBlue(cut), "window 0 \"cut\": the next window shows alone, no blend");
    console.log("✓ a window set to \"cut\" ends on a hard cut");

    const projectCut = await centre(await still("project-cut", { ...legacy, brollTransition: "cut" }, BOUNDARY_FRAME));
    assert.ok(pureBlue(projectCut), "project default \"cut\" applies to windows without their own value");
    const override = await centre(await still("override", {
      bgVideos: [window("red", 0, { transition: "dissolve" }), window("blue", 1), window("red", 2)],
      brollTransition: "cut",
    }, BOUNDARY_FRAME));
    assert.ok(blended(override), "a window's own \"dissolve\" overrides the project default");
    console.log("✓ project default applies to every window; a window's own value overrides it");

    const lastFrame = DURATION_FRAMES - 1;
    const faded = await centre(await still("legacy", legacy, lastFrame));
    assert.ok(faded.r < 40 && faded.g < 40 && faded.b < 40, `default ends on the fade to black (${JSON.stringify(faded)})`);
    const hardEnd = await centre(await still("hard-end", {
      bgVideos: [window("red", 0), window("blue", 1), window("red", 2, { transition: "cut" })],
    }, lastFrame));
    assert.ok(hardEnd.r > 150, `last window "cut": no fade at the end (${JSON.stringify(hardEnd)})`);
    console.log("✓ the last window's \"cut\" removes the end fade; the default keeps it");

    const coverFrame = await still("cover", legacy, 15);
    const coverTop = await top(coverFrame);
    const coverCentre = await centre(coverFrame);
    assert.ok(coverTop.r > coverCentre.r * 0.9, `cover fills the frame (${JSON.stringify({ coverTop, coverCentre })})`);
    const containFrame = await still("contain", {
      bgVideos: [window("red", 0, { fit: "contain" }), window("blue", 1), window("red", 2)],
    }, 15);
    const containTop = await top(containFrame);
    const containCentre = await centre(containFrame);
    console.log(`  contain band ${JSON.stringify(containTop)} vs picture ${JSON.stringify(containCentre)}`);
    assert.ok(containCentre.r > 150, "contain: the whole picture is in the middle");
    assert.ok(containTop.r > 25, "contain: the band shows the same picture, not black");
    assert.ok(containTop.r < containCentre.r * 0.75, "contain: the band is darkened behind the picture");
    console.log("✓ fit \"contain\" letterboxes over a darkened copy; default \"cover\" fills the frame");
  } finally {
    server?.close();
    rmSync(work, { recursive: true, force: true });
    if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  }
  console.log("\nAll broll-window-style render checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
