// Static regression checks for the public Hero Voice presentation.
// Internal provider/API identifiers intentionally remain `omnivoice`.
// Run: npm run verify:hero-voice-ui

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

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
const shell = read("src/app/(dashboard)/video-editor/_v2/EditorV2Shell.tsx");
const jobsRoute = read("src/app/api/videos/jobs/route.ts");

assert.match(brand, /HERO_VOICE_NAME\s*=\s*["']Hero Voice["']/);
assert.match(brand, /HERO_VOICE_COMING_SOON\s*=\s*["']เร็ว ๆ นี้["']/);

assert.match(step2, /value:\s*["']omnivoice["'][\s\S]{0,220}badge:\s*HERO_VOICE_COMING_SOON/,
  "Hero Voice stays visible with its coming-soon badge");
assert.match(step2, /heroVoiceVisible\s*=\s*OMNIVOICE_UI_ENABLED \|\| p\.voiceEngine === "omnivoice"/,
  "the emergency client kill switch can still remove the teaser");
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
