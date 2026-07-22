// Static regression checks for the public Hero Voice presentation.
// Internal provider/API identifiers intentionally remain `omnivoice`.
// Run: npm run verify:hero-voice-ui

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pcmFromWav } from "../src/lib/omnivoice-core";
import {
  RUNPOD_HERO_VOICE_PREVIEWS,
  RUNPOD_HERO_VOICES,
  runpodHeroVoicePreviewFilename,
} from "../src/lib/hero-voice-preview";

const read = (path: string) => readFileSync(path, "utf8");
const occurrences = (source: string, value: string) => source.split(value).length - 1;

const brandPath = "src/lib/hero-voice-brand.ts";
const pickerPath = "src/app/(dashboard)/video-editor/_v2/HeroVoicePicker.tsx";

assert.ok(existsSync(brandPath), "Hero Voice public naming has one shared source");
assert.ok(existsSync(pickerPath), "V2 provides a searchable Hero Voice picker");

const brand = read(brandPath);
const picker = read(pickerPath);
const step2 = read("src/app/(dashboard)/video-editor/_v2/Step2Elements.tsx");
const ui = read("src/app/(dashboard)/video-editor/_v2/ui.tsx");
const legacy = read("src/app/(dashboard)/video-editor/_components/OrderPanel.tsx");
const preview = read("src/app/(dashboard)/video-editor/_components/VoicePreviewButton.tsx");
const voicesRoute = read("src/app/api/omnivoice/voices/route.ts");
const previewRoute = read("src/app/api/omnivoice/preview/[voiceId]/route.ts");
const shell = read("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx");
const jobsRoute = read("src/app/api/videos/jobs/route.ts");

assert.match(brand, /HERO_VOICE_NAME\s*=\s*["']Hero AI Voice["']/);
assert.match(brand, /HERO_VOICE_COMING_SOON\s*=\s*["']เร็ว ๆ นี้["']/);
assert.match(brand, /HERO_VOICE_TEASER_VISIBLE\s*=\s*process\.env\.NEXT_PUBLIC_HERO_VOICE_TEASER\s*!==\s*["']0["']/,
  "Hero Voice teaser is visible by default with an explicit emergency rollback switch");

assert.match(step2, /value:\s*["']omnivoice["'][\s\S]{0,260}badge:\s*p\.omniVoiceEnabled \? ["']Beta · RunPod["'] : HERO_VOICE_COMING_SOON/,
  "Hero AI Voice shows RunPod Beta only when the backend is available");
assert.match(step2, /heroVoiceVisible\s*=\s*HERO_VOICE_TEASER_VISIBLE \|\| OMNIVOICE_UI_ENABLED \|\| p\.voiceEngine === "omnivoice"/,
  "the teaser stays visible independently from provider availability");
assert.match(step2, /disabled:\s*!p\.omniVoiceEnabled/,
  "non-allowlisted users see but cannot select Hero Voice");
assert.match(step2, /max-\[360px\]:grid-cols-\[34px_minmax\(0,1fr\)\]/,
  "the selected voice card stacks safely at 320px");
assert.match(step2, /optionPadding="6px clamp\(7px, 2vw, 14px\)"/,
  "the three provider names fit without truncation at 320px");
assert.match(step2, /<HeroVoicePicker/);
assert.doesNotMatch(step2, /Worker CPU|worker ของระบบ/,
  "end-user voice copy does not expose infrastructure jargon");

assert.match(picker, /type="search"/);
assert.match(picker, /role="radiogroup"/);
assert.match(picker, /role="radio"/);
assert.match(picker, /aria-checked=/);
assert.match(picker, /min-h-11/);

assert.match(ui, /disabled\?:\s*boolean/);
assert.match(ui, /aria-pressed=/);
assert.match(ui, /min-h-11/);
assert.match(step2, /aria-expanded=\{open\}/);
assert.match(step2, /aria-controls=\{panelId\}/);

assert.match(preview, /aria-busy=\{loading\}/);
assert.match(preview, /aria-pressed=\{playing\}/);
assert.match(preview, /min-h-11/);
assert.doesNotMatch(voicesRoute, /preview_url:\s*["']["']/,
  "every RunPod Hero Voice catalog item has a playable preview URL");
assert.match(voicesRoute, /RUNPOD_HERO_VOICES/,
  "the RunPod catalog comes from the shared preview allowlist");
assert.match(previewRoute, /runpodHeroVoicePreviewFilename/,
  "the preview route resolves only allowlisted static Hero Voice assets");
assert.match(previewRoute, /["']Content-Type["']:\s*["']audio\/wav["']/,
  "the preview route serves browser-playable WAV audio");
assert.equal(RUNPOD_HERO_VOICE_PREVIEWS.length, 3,
  "the preview allowlist covers every served RunPod Hero Voice");
assert.equal(RUNPOD_HERO_VOICES.length, RUNPOD_HERO_VOICE_PREVIEWS.length,
  "the RunPod catalog and static preview allowlist cannot drift");
assert.equal(runpodHeroVoicePreviewFilename("../voice_01"), null,
  "preview filename resolution fails closed outside the allowlist");
for (const voice of RUNPOD_HERO_VOICE_PREVIEWS) {
  const catalogItem = RUNPOD_HERO_VOICES.find((item) => item.voice_id === voice.voiceId);
  assert.equal(catalogItem?.preview_url, `/api/omnivoice/preview/${voice.voiceId}`,
    `${voice.voiceId} exposes its authenticated preview route`);
  const assetPath = path.join("assets", "hero-voice-previews", voice.filename);
  assert.ok(existsSync(assetPath), `${voice.voiceId} static preview exists`);
  const audio = readFileSync(assetPath);
  const parsed = pcmFromWav(audio);
  const durationSec = parsed.pcm.length / (parsed.sampleRate * 2);
  assert.equal(parsed.sampleRate, 24_000, `${voice.voiceId} matches the worker sample rate`);
  assert.ok(durationSec >= 2 && durationSec <= 10, `${voice.voiceId} preview duration is browser-friendly`);
}

assert.match(legacy, /HERO_VOICE_NAME/);
assert.match(legacy, /HERO_VOICE_COMING_SOON/);
assert.match(legacy, /disabled=\{pv === "omnivoice" && !omniVoiceEnabled\}/);
assert.match(legacy, /htmlFor="legacy-hero-voice-select"/);
assert.match(legacy, /id="legacy-hero-voice-select"/);

assert.equal(occurrences(shell, 'href="/video-editor?ui=v1"'), 1,
  "the unsupported legacy editor is no longer linked from the mobile account menu");

assert.match(jobsRoute, /Hero Voice ยังไม่เปิดใช้งานสำหรับบัญชีนี้/,
  "user-facing server errors use the public feature name");

console.log("Hero Voice UI regression checks passed.");
