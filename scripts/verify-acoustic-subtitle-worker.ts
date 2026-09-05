import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { runAcousticSubtitleWorker, resolveAcousticAudioFile, acousticSubtitleMode } from "../src/lib/acoustic-subtitle-worker";
import { selectAcousticSubtitleClock } from "../src/lib/acoustic-subtitle-selection";
import { ACOUSTIC_CLOCK_VERSION, ACOUSTIC_MODEL_REVISION } from "../src/lib/acoustic-subtitle-clock";

async function main() {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hero-acoustic-worker-test-"));
  try {
    await fs.mkdir(path.join(dir, "public/renders"), { recursive: true });
    await fs.mkdir(path.join(dir, "scripts/subtitle-alignment"), { recursive: true });
    const audio = path.join(dir, "public/renders/voice.wav");
    await fs.writeFile(audio, Buffer.alloc(100, 1));
    const outside = path.join(dir, "outside.wav");
    await fs.writeFile(outside, Buffer.alloc(100));
    await fs.symlink(outside, path.join(dir, "public/renders/symlink.wav"));
    process.chdir(dir);
    process.env.SUBTITLE_ACOUSTIC_PYTHON = process.execPath;
    process.env.SUBTITLE_ACOUSTIC_CACHE_DIR = path.join(dir, "cache");
    delete process.env.SUBTITLE_ACOUSTIC_MODE;
    assert.equal(acousticSubtitleMode(), "off");
    process.env.SUBTITLE_ACOUSTIC_MODE = "apply";
    delete process.env.SUBTITLE_ACOUSTIC_ROLLOUT_PERCENT;
    assert.equal(acousticSubtitleMode("test-account"), "shadow", "apply needs an explicit cohort percentage");
    process.env.SUBTITLE_ACOUSTIC_ROLLOUT_PERCENT = "100";
    assert.equal(acousticSubtitleMode("test-account"), "apply");
    process.env.SUBTITLE_ACOUSTIC_ROLLOUT_PERCENT = "5";
    assert.equal(acousticSubtitleMode("test-account"), acousticSubtitleMode("test-account"), "cohorts stay stable across jobs");
    process.env.SUBTITLE_ACOUSTIC_MODE = "unexpected";
    assert.equal(acousticSubtitleMode(), "off");
    assert.equal(await resolveAcousticAudioFile("https://example.com/voice.wav"), null);
    assert.equal(await resolveAcousticAudioFile("/api/renders/../outside.wav"), null);
    assert.equal(await resolveAcousticAudioFile("/api/renders/symlink.wav"), null);
    assert.equal(await resolveAcousticAudioFile("/api/renders/voice.wav"), await fs.realpath(audio));

    // Real child-process protocol, using a lightweight local fixture instead of
    // downloading weights in CI. The argv contains only the runner filename.
    const runner = path.join(dir, "scripts/subtitle-alignment/engine.py");
    await fs.writeFile(runner, `
      const fs = require('node:fs'); const crypto = require('node:crypto');
      let input = ''; process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        const r = JSON.parse(input);
        if (process.env.ACOUSTIC_TEST_HANG === '1') { setInterval(() => {}, 1000); return; }
        fs.appendFileSync('calls.txt', '1');
        console.log(JSON.stringify({ version: '${ACOUSTIC_CLOCK_VERSION}', modelRevision: '${ACOUSTIC_MODEL_REVISION}',
          audioHash: r.audioHash, textHash: crypto.createHash('sha256').update(r.text).digest('hex'),
          audioDurationMs: 5000, characters: [...r.text].map((c,i) => ({ startChar:i, endChar:i+1,
            startMs:200+i*100, endMs:300+i*100, confidence:.99, diagnostic:'PRIVATE_MARKER' })) }));
      });
    `);
    const args = { audioUrl: "/api/renders/voice.wav", text: "แมว", audioDurationMs: 5000, mode: "shadow" as const, budgetMs: 2000 };
    const first = await runAcousticSubtitleWorker(args);
    assert(first.clock);
    assert.equal(first.evidence.cacheHit, false);
    const shadow = selectAcousticSubtitleClock({ text: args.text, maxCardChars: 30, existingTimingSource: "tts_segment_timing", result: first });
    assert.equal(shadow.evidence.status, "aligned");
    assert.equal(shadow.replacement, undefined, "shadow cannot alter render timing");
    const apply = selectAcousticSubtitleClock({ text: args.text, maxCardChars: 30, existingTimingSource: "tts_segment_timing", result: { ...first, evidence: { ...first.evidence, mode: "apply" } } });
    assert(apply.replacement);
    assert.equal(apply.replacement.words[0].startMs, 200);
    assert.equal(apply.evidence.applied, true);
    const second = await runAcousticSubtitleWorker(args);
    assert.equal(second.evidence.cacheHit, true);
    assert.equal(await fs.readFile(path.join(dir, "calls.txt"), "utf8"), "1");
    const files = await fs.readdir(path.join(dir, "cache"));
    const cache = path.join(dir, "cache", files.find(f => f.endsWith(".json"))!);
    assert(!((await fs.readFile(cache, "utf8")).includes("PRIVATE_MARKER")), "untrusted child additions never enter cache");
    assert.equal((await fs.stat(cache)).mode & 0o777, 0o600);
    const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await fs.utimes(cache, expiredAt, expiredAt);
    const expired = await runAcousticSubtitleWorker(args);
    assert.equal(expired.evidence.cacheHit, false, "expired cache entries are recomputed");
    await fs.writeFile(audio, Buffer.alloc(100, 2));
    const changed = await runAcousticSubtitleWorker(args);
    assert(changed.clock);
    assert.notEqual(changed.evidence.audioHash, first.evidence.audioHash, "changed audio invalidates the old clock");
    assert.equal(changed.evidence.cacheHit, false);
    process.env.ACOUSTIC_TEST_HANG = "1";
    const timeout = await runAcousticSubtitleWorker({ ...args, text: "ปลา", budgetMs: 100 });
    assert.equal(timeout.clock, undefined);
    assert.equal(timeout.evidence.status, "timeout", "hung process is killed and becomes a fallback result");
    assert.equal(selectAcousticSubtitleClock({ text: "ปลา", maxCardChars: 30, existingTimingSource: "forced_alignment", result: timeout }).replacement, undefined);
    delete process.env.ACOUSTIC_TEST_HANG;
    const mismatch = await runAcousticSubtitleWorker({ ...args, audioDurationMs: 8000 });
    assert.equal(mismatch.clock, undefined, "duration mismatch cannot adopt stale media timing");
    assert.equal(first.clock.textHash, createHash("sha256").update(args.text).digest("hex"));
    console.log("acoustic subtitle worker: path isolation, shadow/apply, cache identity/privacy, deadline and fallback PASS");
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
