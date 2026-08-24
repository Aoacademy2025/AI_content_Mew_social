import assert from "node:assert/strict";
import fs from "node:fs";

const read = (filename: string) => fs.readFileSync(filename, "utf8");

const schema = read("prisma/schema.prisma");
const storage = read("src/lib/user-voices.server.ts");
const collectionRoute = read("src/app/api/omnivoice/user-voices/route.ts");
const itemRoute = read("src/app/api/omnivoice/user-voices/[id]/route.ts");
const catalogRoute = read("src/app/api/ai-studio/catalog/route.ts");
const studioVoiceRoute = read("src/app/api/ai-studio/voices/route.ts");
const studioPage = read("src/app/(dashboard)/ai-studio/page.tsx");
const clonePanel = read("src/app/(dashboard)/ai-studio/HeroVoiceClonePanel.tsx");
const cloneUi = `${studioPage}\n${clonePanel}`;
const provider = read("src/lib/omnivoice.ts");
const durable = read("src/lib/hero-voice-generation.server.ts");
const policy = read("src/lib/omnivoice-policy.ts");

assert.match(schema, /model UserVoice\s*\{/);
assert.match(schema, /userVoices\s+UserVoice\[\]/);
assert.match(storage, /uploads["'], ["']user-voices/,
  "reference audio stays outside public/");
assert.match(storage, /MAX_REF_MS\s*=\s*15_000/,
  "the app must not accept references longer than the worker's 15-second contract");
assert.match(storage, /mode:\s*0o700/,
  "the private reference directory is owner-only");
assert.match(storage, /mode:\s*0o600/,
  "reference WAV files are owner-only");
assert.doesNotMatch(storage, /public["'], ["']user-voices/);
assert.match(storage, /User voice storage must stay outside public\//,
  "configured storage cannot expose private references through public/");

for (const route of [collectionRoute, itemRoute]) {
  assert.match(route, /user\.role !== ["']ADMIN["']/,
    "clone management remains admin-only during the private rollout");
  assert.match(route, /isOmniVoiceUserAllowed/,
    "clone management follows the Hero Voice rollout allowlist");
}
assert.match(collectionRoute, /consent/,
  "upload requires an explicit voice-rights acknowledgement");
assert.match(itemRoute, /Cache-Control["']:\s*["']private, no-store["']/,
  "private reference playback must not be cached");

assert.match(policy, /HERO_VOICE_CLONING_ENABLED\s*===\s*["']1["']/,
  "clone rollout is fail-closed behind a dedicated switch");
assert.match(catalogRoute, /cloning:\s*isHeroVoiceCloningEnabled\(\)[\s\S]{0,100}user\.role === ["']ADMIN["']/);
assert.match(studioVoiceRoute, /isUserVoiceId/,
  "the submission route distinguishes custom voices before durable generation");
assert.match(studioPage, /["']cloning["'], ["']โคลนเสียง["']/);
assert.match(cloneUi, /navigator\.mediaDevices\.getUserMedia/);
assert.match(cloneUi, /REF_MAX_SEC\s*=\s*15/);
assert.match(cloneUi, /ยืนยันว่าฉันเป็นเจ้าของเสียง/);
assert.doesNotMatch(cloneUi, /JaiTTS|สร้างด้วย Jai|ยิงทั้งคู่/,
  "Production clone UI exposes only the approved RunPod v2 path");

assert.match(provider, /mode:\s*["']clone["']/);
assert.match(provider, /ref_audio_b64/);
assert.match(provider, /expectedMode/,
  "durable polling validates the response against the submitted mode");
assert.match(durable, /loadUserVoiceRef/);
assert.match(durable, /const mode = isUserVoiceId/);
assert.match(durable, /providerModel:\s*generationMode\(nextState\) === ["']clone["']/,
  "every clone chunk remains labelled as the clone provider model");
assert.doesNotMatch(durable, /audioBase64:\s*ref\./,
  "biometric-ish reference bytes must never be persisted in durable job JSON");

console.log("Hero Voice clone security, UI, and RunPod contract checks passed.");
