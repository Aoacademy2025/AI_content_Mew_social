// Pure contract checks for the OmniVoice app/worker boundary.
// Run: npm run verify:omnivoice

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import thaiSpeechCases from "../data/hero-voice/thai-speech-cases.json";
import {
  createOmniVoiceAdmissionCounter,
  isOmniVoiceInfo,
  isValidOmniVoiceId,
  pcmFromWav,
  userInOmniVoiceAllowlist,
} from "../src/lib/omnivoice-core";
import {
  prepareHeroVoiceSpeech,
  prepareHeroVoiceSpeechText,
  splitHeroVoiceScriptForTts,
} from "../src/lib/hero-voice-speech";
import { parseTtsProvider, resolveJobTtsProvider } from "../src/lib/tts-providers";
import { evaluateHeroVoiceTranscripts } from "../src/lib/hero-voice-asr-gate";
import { omnivoiceScriptCharCapForPlan } from "../src/lib/omnivoice-limits";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

function monoPcm16Wav(sampleRate = 24_000, pcm = Buffer.alloc(480)): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

check("allowlist: missing config fails closed", !userInOmniVoiceAllowlist("user_a", undefined));
check("allowlist: empty config fails closed", !userInOmniVoiceAllowlist("user_a", ""));
check("allowlist: exact canary user passes", userInOmniVoiceAllowlist("user_a", "user_b, user_a"));
check("allowlist: other user denied", !userInOmniVoiceAllowlist("user_c", "user_b,user_a"));
check("allowlist: global rollout requires explicit wildcard", userInOmniVoiceAllowlist("any_user", "*"));
check("provider rollback: saved OmniVoice default falls back to Gemini", resolveJobTtsProvider(undefined, "omnivoice") === "gemini");
check("provider parity: saved ElevenLabs default remains ElevenLabs", resolveJobTtsProvider(undefined, "elevenlabs") === "elevenlabs");
check("provider canary: explicit OmniVoice job remains explicit", resolveJobTtsProvider("omnivoice", "gemini") === "omnivoice");
check("draft: explicit OmniVoice selection is preserved while unavailable", parseTtsProvider("omnivoice") === "omnivoice");

const admission = createOmniVoiceAdmissionCounter(3);
const leases = [admission.tryAcquire(), admission.tryAcquire(), admission.tryAcquire()];
check("admission: allows worker active+pending envelope", leases.every(Boolean) && admission.inFlight() === 3);
check("admission: rejects requests beyond three in flight", admission.tryAcquire() === null);
leases[0]?.release();
check("admission: release opens one slot", admission.tryAcquire() !== null && admission.inFlight() === 3);

check("voice id: accepts worker identifiers", isValidOmniVoiceId("voice_01-A"));
check("voice id: rejects traversal", !isValidOmniVoiceId("../voice_01"));
check("voice id: rejects whitespace", !isValidOmniVoiceId("voice 01"));
check("voice id: enforces length", !isValidOmniVoiceId("v".repeat(65)));
check("voice payload: accepts required fields", isOmniVoiceInfo({
  voice_id: "voice_01", desc: "Thai voice", instruct: "calm", preview_url: "/preview",
}));
check("voice payload: rejects missing preview URL", !isOmniVoiceInfo({
  voice_id: "voice_01", desc: "Thai voice", instruct: "calm",
}));
check("voice payload: rejects empty preview URL", !isOmniVoiceInfo({
  voice_id: "voice_01", desc: "Thai voice", instruct: "calm", preview_url: "",
}));
check("voice payload: rejects invalid id", !isOmniVoiceInfo({
  voice_id: "../../etc", desc: "bad", instruct: "bad", preview_url: "/preview",
}));

check(
  "speech text: Thai cardinal numbers follow the approved reading",
  prepareHeroVoiceSpeechText("ซอย15 เลขที่150 และมากกว่า 150 เท่า")
    === "ซอยสิบห้าเลขที่หนึ่งร้อยห้าสิบและมากกว่าหนึ่งร้อยห้าสิบเท่า",
);
check(
  "speech text: Thai cardinal grammar covers zero, tens, millions, decimals, and negatives",
  prepareHeroVoiceSpeechText("0 10 11 20 21 101 1,001 1,000,001 1.05 -5")
    === "ศูนย์ สิบ สิบเอ็ด ยี่สิบ ยี่สิบเอ็ด หนึ่งร้อยเอ็ด หนึ่งพันเอ็ด หนึ่งล้านเอ็ด หนึ่งจุดศูนย์ห้า ลบห้า",
);
check(
  "speech text: attached and spaced Thai repetition marks are spoken",
  prepareHeroVoiceSpeechText("ค่อยๆ จริง ๆ และกลายๆ")
    === "ค่อย ค่อย จริง จริง และกลาย กลาย",
);
check(
  "speech text: audited English names use Thai-accent pronunciations",
  prepareHeroVoiceSpeechText(
    "ChatGPT MIT Your Brain on ChatGPT Google Roske AI Richard Benjamins AI Telefonica",
  ) === "แชตจีพีทีเอ็มไอทียัวร์เบรนออนแชตจีพีทีกูเกิลรอสก์เอไอริชาร์ดเบนจามินส์เอไอเทเลโฟนิกา",
);
check(
  "speech text: transliterated names are glued to their Thai neighbours (Mew-approved glue rule)",
  prepareHeroVoiceSpeechText("คุณ Richard Benjamins จาก Telefonica พูดถึง ChatGPT")
    === "คุณริชาร์ดเบนจามินส์จากเทเลโฟนิกาพูดถึงแชตจีพีที",
);
check(
  "speech text: listed acronyms use their colloquial reading, unlisted ones are spelled",
  prepareHeroVoiceSpeechText("CEO ใช้ API และ GPT-5")
    === "ซีอีโอใช้เอพีไอและจีพีที-ห้า",
);
check(
  "speech text: phone and one-time codes are read digit by digit",
  prepareHeroVoiceSpeechText("เบอร์โทร 081-234-5678 OTP 150 PIN 042")
    === "เบอร์โทรศูนย์แปดหนึ่ง-สองสามสี่-ห้าหกเจ็ดแปดโอทีพีหนึ่งห้าศูนย์พีไอเอ็นศูนย์สี่สอง",
);
for (const fixture of thaiSpeechCases) {
  const actual = prepareHeroVoiceSpeechText(fixture.display);
  check(
    `speech fixture: ${fixture.id}`,
    actual === fixture.spoken,
    `expected=${fixture.spoken}\n        actual=${actual}`,
  );
  check(
    `speech fixture idempotence: ${fixture.id}`,
    prepareHeroVoiceSpeechText(actual) === actual,
  );
  check(
    `speech fixture required tokens: ${fixture.id}`,
    fixture.requiredTokens.every((token) => actual.includes(token)),
  );
}
check(
  "speech preflight: resolved percentage has no blocking risk",
  prepareHeroVoiceSpeech("แม่น 30%").risks.every((risk) => risk.severity !== "block"),
);
check(
  "speech preflight: unsupported per-mille is blocked before provider spend",
  prepareHeroVoiceSpeech("ความคลาดเคลื่อน 3‰").risks.some(
    (risk) => risk.code === "unexpanded_percent" && risk.severity === "block",
  ),
);
check(
  "speech preflight: ambiguous fraction is blocked instead of guessed",
  prepareHeroVoiceSpeech("ใช้ส่วนผสม 1/2 ถ้วย").risks.some(
    (risk) => risk.code === "ambiguous_numeric_slash" && risk.severity === "block",
  ),
);
check(
  "speech preflight: supported วันที่ DD/MM/YYYY is not mistaken for a fraction",
  !prepareHeroVoiceSpeech("วันที่ 24/07/2569").risks.some(
    (risk) => risk.code === "ambiguous_numeric_slash",
  ),
);
check(
  "speech preflight: unreviewed English is visible without blocking Thai synthesis",
  prepareHeroVoiceSpeech("เริ่มทำ marketing วันนี้").risks.some(
    (risk) => risk.code === "unreviewed_latin" && risk.severity === "review",
  ),
);
check(
  "speech preflight: URLs and email addresses are reviewable without logging their content",
  ["url", "email"].every((code) => (
    prepareHeroVoiceSpeech("ดู https://example.com หรือส่ง hello@example.com").risks.some(
      (risk) => risk.code === code && risk.severity === "review",
    )
  )),
);
check(
  "speech preflight: unsupported currency symbol is blocked",
  prepareHeroVoiceSpeech("ราคา ¥100").risks.some(
    (risk) => risk.code === "unexpanded_currency" && risk.severity === "block",
  ),
);
const expandingScript = "ยอดเพิ่ม 150 เท่า จริงๆ ChatGPT ".repeat(20).trim();
const speechChunks = splitHeroVoiceScriptForTts(expandingScript, 90);
check(
  "speech chunks: preserve the display script while every provider payload stays within its limit",
  speechChunks.map((chunk) => chunk.text).join("") === expandingScript
    && speechChunks.every((chunk) => (
      chunk.speechText === prepareHeroVoiceSpeechText(chunk.text)
      && chunk.speechText.length <= 90
    )),
);
const crossBoundaryEnglish = splitHeroVoiceScriptForTts("Your Brain on ChatGPT", 15);
check(
  "speech chunks: Thai-accent pronunciation survives an English phrase boundary",
  crossBoundaryEnglish.map((chunk) => chunk.text).join("") === "Your Brain on ChatGPT"
    && crossBoundaryEnglish.every((chunk) => !/[A-Za-z]/.test(chunk.speechText)),
);

const twoSentences = "วันนี้มิวใช้ Hero AI Studio สร้าง short video สำหรับ YouTube และ TikTok ครับ เริ่มจากเขียน content แล้วเลือก voice cloning ก่อนกด preview และ export เป็นไฟล์ video ครับ";
const sentenceChunks = splitHeroVoiceScriptForTts(twoSentences, 800);
check(
  "speech chunks: sentence-final ครับ starts a new chunk even under the char cap (Mew-approved: short chunks stop end-of-clip slurring)",
  sentenceChunks.length === 2
    && sentenceChunks.map((chunk) => chunk.text).join("") === twoSentences
    && sentenceChunks[0].text.endsWith("ครับ ")
    && sentenceChunks[1].text.startsWith("เริ่มจาก")
    && sentenceChunks[1].startChar === sentenceChunks[0].endChar,
  `got ${sentenceChunks.length} chunks: ${JSON.stringify(sentenceChunks.map((chunk) => chunk.text))}`,
);
const mixedEndings = "ประโยคแรกค่ะ ประโยคสองครับ\nบรรทัดใหม่. Final line? ครับ";
const mixedChunks = splitHeroVoiceScriptForTts(mixedEndings, 800);
check(
  "speech chunks: ค่ะ, newline, and terminal punctuation are sentence boundaries; a tiny tail merges into the previous chunk",
  JSON.stringify(mixedChunks.map((chunk) => chunk.text))
    === JSON.stringify(["ประโยคแรกค่ะ ", "ประโยคสองครับ\n", "บรรทัดใหม่. ", "Final line? ครับ"]),
  JSON.stringify(mixedChunks.map((chunk) => chunk.text)),
);

// ASR content gate (Mew-approved loop, 2026-09-06): the worker's best-of-3 ranking
// picks by speaker similarity and can select a candidate that skipped words, so
// every chunk is transcribed and compared to the intended speech text.
const chunkTwo = "ระบบเชื่อมต่อผ่านเอพีไอใช้จีพียูประมวลผล แล้วส่งไฟล์เวฟและเอ็มพีสามกลับมาที่แดชบอร์ดครับ";
check(
  "asr gate: a transcript missing a whole phrase fails",
  evaluateHeroVoiceTranscripts(chunkTwo, ["ครับ API ใช้ GPU ประมวลผล แล้วส่งไฟล์ .wav และ .mp3 กลับมาที่แดชบอร์ดครับ"]).pass === false,
);
check(
  "asr gate: passes when any ear heard every word, even with English spellings from the other ear",
  evaluateHeroVoiceTranscripts(
    "ทดสอบคำว่ารันพ็อดเซิร์ฟเวอร์เลส, ออมนิวอยซ์, เจมิไน, อีเลเว่นแล็บส์และรีโมชันครับ",
    ["ทดสอบคำว่า RunPod, Serverless, OmniVoice, Gemini, ElevenLabs และ Remotion ครับ",
     "ทดสอบคำว่า รันพอด เซิร์ฟเวอร์เลส ออมนิวอยซ์ เจมินาย อีเลฟเว่นแล็บส์ และ รีโมชั่น ครับ"],
  ).pass === true,
);
check(
  "asr gate: numerals in the transcript are read through the normalizer before comparing",
  evaluateHeroVoiceTranscripts(
    "สินค้าราคาหนึ่งพันสองร้อยห้าสิบบาทห้าสิบสตางค์ ลดสิบห้าเปอร์เซ็นต์เหลือหนึ่งพันหกสิบสองจุดเก้าสองห้าบาทครับ",
    ["สินค้า ราคา 1,250 บาท 50 สตางค์ ลด 15% เหลือ 1,062.925 บาท ครับ"],
  ).pass === true,
);
check(
  "asr gate: a one-word slip is tolerated, a five-letter run is not",
  evaluateHeroVoiceTranscripts("วันนี้อากาศดีมากครับ", ["วันนี้อากาศดีครับ"]).pass === true
    && evaluateHeroVoiceTranscripts("วันนี้อากาศดีมากครับ", ["วันนี้ครับ"]).pass === false,
);

const pcm = Buffer.from([0, 0, 1, 0, 255, 255, 2, 0]);
const parsed = pcmFromWav(monoPcm16Wav(24_000, pcm));
check("wav parser: preserves PCM bytes", parsed.pcm.equals(pcm));
check("wav parser: preserves sample rate", parsed.sampleRate === 24_000);
check("wav parser: rejects non-WAV", throws(() => pcmFromWav(Buffer.from("not a wav"))));

const stereo = monoPcm16Wav();
stereo.writeUInt16LE(2, 22);
check("wav parser: rejects stereo worker output", throws(() => pcmFromWav(stereo)));
const truncated = monoPcm16Wav();
truncated.writeUInt32LE(truncated.length, 40);
check("wav parser: rejects truncated chunks", throws(() => pcmFromWav(truncated)));

const orchestratorSource = fs.readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
const jobsRouteSource = fs.readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const omniRouteSource = fs.readFileSync("src/app/api/videos/tts-omnivoice/route.ts", "utf8");
const configSource = fs.readFileSync("src/lib/omnivoice.ts", "utf8");
const durableVoiceSource = fs.readFileSync("src/lib/hero-voice-generation.server.ts", "utf8");
check(
  "orchestrator: Hero Voice uses durable provider submit/poll/resume",
  orchestratorSource.includes("startHeroVoiceGeneration")
    && orchestratorSource.includes("advanceHeroVoiceGeneration")
    && orchestratorSource.includes("parkHeroVoiceProviderJob")
    && !orchestratorSource.includes('"/api/videos/tts-omnivoice"'),
);
check(
  "orchestrator: Hero Voice receives the persisted NarrationPlan speech text",
  orchestratorSource.includes("text: narrationText"),
);
check(
  "provider pin: accepted Hero Voice jobs retain endpoint and voice",
  durableVoiceSource.includes("providerEndpoint: config.endpointId")
    && durableVoiceSource.includes("endpointId = job.providerEndpoint")
    && durableVoiceSource.includes("voiceId: input.voiceId"),
);
check(
  "provider pin: Hero Voice errors never recommend a cross-provider fallback",
  !omniRouteSource.includes("fallbackProvider")
    && !omniRouteSource.includes("Gemini/ElevenLabs")
    && !omniRouteSource.includes("สลับเป็น Gemini"),
);
check("job admission: OmniVoice readiness is checked before enqueue", jobsRouteSource.includes("await checkOmniVoiceReady(config)"));
check(
  "speech boundary: worker receives pronunciation text while timing keeps display text",
  omniRouteSource.includes("splitHeroVoiceScriptForTts(fullText, config.maxChunkChars)")
    && omniRouteSource.includes("chunks[index].speechText")
    && omniRouteSource.includes("text: chunk.text"),
);
check(
  "speech preflight: blocking tokens stop before managed-audio reservation",
  omniRouteSource.indexOf('blockingSpeechRisks.length > 0')
    < omniRouteSource.indexOf("reserveAiAudioMinutes(user.id, estimatedMinutes, { enforce: true })"),
);
check(
  "job admission: blocking speech tokens fail before a VideoJob is created",
  jobsRouteSource.includes("prepareHeroVoiceSpeech(script)")
    && jobsRouteSource.indexOf("blockingSpeechRisks.length > 0")
      < jobsRouteSource.lastIndexOf("createVideoJob("),
);
check("capacity: managed AI-audio reserve is enforced", omniRouteSource.includes("reserveAiAudioMinutes(user.id, estimatedMinutes, { enforce: true })"));
check("Studio voice: package minutes are reserved before worker generation", omniRouteSource.includes("studioReservedMin = Math.max(1, Math.ceil(estimatedMinutes))") && omniRouteSource.includes("reserveMinutes(user.id, studioReservedMin)"));
check("Studio voice: failed worker generation refunds package minutes", omniRouteSource.includes("refundMinutes(user.id, studioReservedMin)"));
check(
  "quality: every production voice is fixed at the upstream 32-step default",
  configSource.includes("const OMNIVOICE_QUALITY_NUM_STEP = 32")
    && configSource.includes("numStep: OMNIVOICE_QUALITY_NUM_STEP"),
);
check("capacity: upstream chunks default below legacy 500-char worker ceiling", configSource.includes("800,") && configSource.includes("450,"));
check("package: Free script cap follows the 2-minute tier", omnivoiceScriptCharCapForPlan("FREE") === 1680);
check("package: Pro script cap follows the 6-minute tier", omnivoiceScriptCharCapForPlan("PRO") === 5040);
check("package: Business script cap follows the 10-minute tier", omnivoiceScriptCharCapForPlan("BUSINESS") === 8400);
check("timeout: route supports long package-compliant jobs", /840_000,\s*540_000/.test(configSource));
check(
  "cost guard: legacy queued RunPod jobs allow the approved five-minute wait",
  configSource.includes("OMNIVOICE_QUEUE_WAIT_BUDGET_MS")
    && /300_000,\s*300_000/.test(configSource)
    && configSource.includes('snapshot.status === "IN_QUEUE"'),
);
check(
  "cost guard: abandoned legacy RunPod jobs are cancelled without cross-provider advice",
  configSource.includes("/cancel/${encodeURIComponent(providerJobId)}")
    && omniRouteSource.includes('"OMNIVOICE_QUEUE_TIMEOUT"')
    && !omniRouteSource.includes("fallbackProvider"),
);
check("RunPod: provider POST is never automatically retried", configSource.includes("Never automatically retry this POST"));
check("RunPod: queue jobs are polled by their durable provider id", configSource.includes("status/${encodeURIComponent(providerJobId)}"));
check("RunPod: readiness does not cold-start a paid worker", configSource.includes("RUNPOD_REST_API"));
check(
  "RunPod: every synthesis request uses the Hero Voice v2 contract",
  configSource.includes("HERO_VOICE_RUNPOD_CONTRACT_VERSION = 2")
    && configSource.includes('mode: "tts" as const')
    && configSource.includes("mixed_language: true"),
);
check(
  "RunPod: completed jobs must identify the v2 worker and catalog",
  configSource.includes("validRunpodPayload")
    && configSource.includes("value.catalog_version")
    && configSource.includes("value.worker_version"),
);

const backgroundRuntimeImport = spawnSync(
  process.execPath,
  ["--conditions=react-server", "--import", "tsx", "-e", 'import("./src/lib/mcp/orchestrator.ts")'],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, OMNIVOICE_ENABLED: "0" },
  },
);
check(
  "background runtime: MCP orchestrator imports outside Next.js",
  backgroundRuntimeImport.status === 0,
  backgroundRuntimeImport.stderr.trim(),
);

const runpodCancellationRuntime = spawnSync(
  process.execPath,
  [
    "--conditions=react-server",
    "--import",
    "tsx",
    "scripts/verify-omnivoice-runpod-runtime.ts",
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);
check(
  "RunPod runtime: queued job is cancelled before the timeout returns",
  runpodCancellationRuntime.status === 0,
  [runpodCancellationRuntime.stdout, runpodCancellationRuntime.stderr].join("\n").trim(),
);

const durableRuntime = spawnSync(
  "npx",
  ["tsx", "scripts/verify-hero-voice-durable.ts"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
  },
);
check(
  "durable runtime: >120s queue delay resumes on the pinned provider job",
  durableRuntime.status === 0,
  [durableRuntime.stdout, durableRuntime.stderr].join("\n").trim(),
);

if (failures > 0) {
  console.error(`\n${failures} OmniVoice verification(s) failed.`);
  process.exit(1);
}
console.log("\nOmniVoice contract checks passed.");
