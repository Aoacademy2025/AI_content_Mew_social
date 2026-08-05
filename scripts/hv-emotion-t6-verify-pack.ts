// T6 (hv-emotion) — Step 2 verification: script the checks, don't eyeball.
// 1. Exactly 144 pack audio files exist (48 trials x 3 slots).
// 2. Every <audio src="..."> path parsed OUT OF the actual index.html resolves
//    to an existing file on disk (catches generator bugs, not just re-derives
//    the same math the generator used).
// 3. Non-silence check delegated to hv-emotion-check-non-silent.py (spawned
//    here so the whole gate is one command).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..");
const PACK_ROOT = path.join(REPO_ROOT, "artifacts", "hero-voice-ab-2026-07-24", "pack");
const INDEX_HTML = path.join(PACK_ROOT, "index.html");

function fail(msg: string): never {
  console.error(JSON.stringify({ event: "VERIFY-FAIL", msg }));
  process.exit(1);
}

if (!existsSync(INDEX_HTML)) fail(`missing ${INDEX_HTML}`);
const html = readFileSync(INDEX_HTML, "utf-8");

const srcMatches = [...html.matchAll(/<audio[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
console.log(JSON.stringify({ event: "audio-src-count-in-html", count: srcMatches.length }));

if (srcMatches.length !== 144) fail(`expected 144 <audio src> entries in index.html, found ${srcMatches.length}`);

const missing: string[] = [];
const resolvedPaths: string[] = [];
for (const src of srcMatches) {
  const abs = path.join(PACK_ROOT, src);
  resolvedPaths.push(abs);
  if (!existsSync(abs)) missing.push(src);
}
if (missing.length > 0) fail(`HTML references ${missing.length} audio paths that do not exist on disk: ${missing.slice(0, 10).join(", ")}`);

// Also confirm no leakage: HTML must not contain any voice_ catalog ID or
// any of the internal arm-kind words ("winner"/"baseline"/"gemini" as
// identifying labels — "gemini" text check excluded since it never appears,
// verified via grep below).
if (/voice_\d\d/.test(html)) fail("index.html contains a voice_XX persona ID — blinding leak");
for (const word of ["winner", "baseline", "gemini", "Aoede", "Puck"]) {
  if (new RegExp(word, "i").test(html)) fail(`index.html contains the word "${word}" — possible blinding leak`);
}

console.log(JSON.stringify({ event: "html-audio-paths-verified", count: resolvedPaths.length }));

// Non-silence check via the stdlib WAV checker, streamed over the resolved paths.
const fileListInput = resolvedPaths.join("\n");
let nonSilentOutput = "";
try {
  nonSilentOutput = execFileSync("python3", [path.join(REPO_ROOT, "scripts", "hv-emotion-check-non-silent.py")], {
    input: fileListInput,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 20,
  });
} catch (error) {
  const stdout = (error as { stdout?: string }).stdout ?? "";
  nonSilentOutput = stdout;
}

const rows = nonSilentOutput
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { file: string; ok: boolean; reason: string | null; peak: number | null; duration_s: number | null });

const bad = rows.filter((r) => !r.ok);
console.log(JSON.stringify({ event: "non-silence-check", total: rows.length, ok: rows.length - bad.length, bad: bad.length }));
if (bad.length > 0) {
  fail(`non-silence check failed for ${bad.length} files: ${JSON.stringify(bad.slice(0, 10))}`);
}
if (rows.length !== 144) fail(`expected to check 144 files, checked ${rows.length}`);

console.log(JSON.stringify({ event: "VERIFY-PASS", htmlAudioEntries: srcMatches.length, filesOnDisk: 144, nonSilent: 144 }));
