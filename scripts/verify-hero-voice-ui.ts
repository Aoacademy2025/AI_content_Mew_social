// Static regression checks for the public Hero Voice presentation.
// Internal provider/API identifiers intentionally remain `omnivoice`.
// Run: npm run verify:hero-voice-ui

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

assert.match(step2, /value:\s*["']omnivoice["'][\s\S]{0,260}badge:\s*p\.omniVoiceEnabled \? ["']แนะนำ · 48 เสียง["'] : HERO_VOICE_COMING_SOON/,
  "Hero AI Voice advertises its 48-voice recommended catalog only when the backend is available");
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
assert.match(step2, /value:\s*["']omnivoice["'][\s\S]{0,220}badge:\s*p\.omniVoiceEnabled \? ["']แนะนำ · 48 เสียง["']/,
  "Hero AI Voice is presented as the recommended 48-voice option when available");
assert.ok(
  step2.indexOf('value: "omnivoice"') < step2.indexOf('value: "gemini"'),
  "Hero AI Voice appears before Gemini in the V2 provider selector",
);
assert.match(ui, /featured\?:\s*boolean/,
  "the shared provider selector supports a deliberate featured treatment");
assert.doesNotMatch(step2, /Beta · RunPod|เวอร์ชันทดลอง · RunPod|เวอร์ชันทดลองบน RunPod/,
  "customer-facing provider selection uses the Hero product, not infrastructure labels");

assert.match(picker, /type="search"/);
assert.match(picker, /role="radiogroup"/);
assert.match(picker, /role="radio"/);
assert.match(picker, /aria-checked=/);
assert.match(picker, /min-h-11/);
assert.match(picker, /voice\.preview_url/,
  "each Hero Voice row owns its static preview URL");
assert.match(picker, /ฟังเสียงตัวอย่าง/,
  "each Hero Voice row exposes a named preview action");
assert.match(picker, /previewingVoiceId/,
  "the picker coordinates one active row preview at a time");
assert.match(step2, /p\.voiceEngine !== ["']omnivoice["'][\s\S]{0,180}<VoicePreviewButton/,
  "Hero Voice preview moved from the selected card into the voice list");

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
assert.equal(RUNPOD_HERO_VOICE_PREVIEWS.length, 48,
  "the preview allowlist covers every served RunPod Hero Voice");
assert.equal(RUNPOD_HERO_VOICES.length, RUNPOD_HERO_VOICE_PREVIEWS.length,
  "the RunPod catalog and static preview allowlist cannot drift");
assert.deepEqual(
  RUNPOD_HERO_VOICE_PREVIEWS.map((voice) => voice.voiceId),
  Array.from({ length: 48 }, (_, index) => `voice_${String(index + 1).padStart(2, "0")}`),
  "the RunPod catalog preserves all 48 original Hero Voice IDs in order",
);
assert.equal(runpodHeroVoicePreviewFilename("../voice_01"), null,
  "preview filename resolution fails closed outside the allowlist");
const recoveredVoice44 = RUNPOD_HERO_VOICE_PREVIEWS.find((voice) => voice.voiceId === "voice_44");
assert.equal(recoveredVoice44?.instruct, "young adult, male, very high pitch",
  "voice_44 exposes the completed Hero-Voice-Ai v2 profile");
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
  assert.ok(durationSec >= 1.5 && durationSec <= 10, `${voice.voiceId} preview duration is browser-friendly`);
  if (voice.voiceId === "voice_44") {
    assert.equal(
      createHash("sha256").update(audio).digest("hex"),
      "c143fc1a1e957c948bb67e58075d2070450531c7c202879ac8068436378c5810",
      "voice_44 serves the completed Hero-Voice-Ai v2 reference preview",
    );
  }
}

assert.match(legacy, /HERO_VOICE_NAME/);
assert.match(legacy, /HERO_VOICE_COMING_SOON/);
assert.match(legacy, /disabled=\{pv === "omnivoice" && !omniVoiceEnabled\}/);
assert.match(legacy, /\(\[\.\.\.\(HERO_VOICE_TEASER_VISIBLE[\s\S]{0,180}\["omnivoice"\][\s\S]{0,80}"gemini",\s*"elevenlabs"\]/,
  "the legacy provider selector also leads with Hero AI Voice");
assert.match(legacy, /pv === "omnivoice"[\s\S]{0,180}omniVoiceEnabled \? "แนะนำ/,
  "the legacy provider selector identifies available Hero AI Voice as recommended");
assert.match(legacy, /htmlFor="legacy-hero-voice-select"/);
assert.match(legacy, /id="legacy-hero-voice-select"/);

assert.equal(occurrences(shell, 'href="/video-editor?ui=v1"'), 0,
  "the unsupported legacy editor is no longer linked from the mobile account menu");

assert.match(jobsRoute, /Hero Voice ยังไม่เปิดใช้งานสำหรับบัญชีนี้/,
  "user-facing server errors use the public feature name");

console.log("Hero Voice UI regression checks passed.");
