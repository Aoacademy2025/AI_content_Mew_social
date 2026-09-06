import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decodeHeroVoiceCanaryBase64url,
  decryptHeroVoiceCanaryReveal,
  deriveHeroVoiceCanaryRunKey,
  encryptHeroVoiceCanaryReveal,
  heroVoiceCanaryHmacHex,
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "../src/lib/hero-voice-canary-canonical";
import {
  buildHeroVoiceCanaryManifest,
  computeHeroVoiceCanaryCost,
  HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  HERO_VOICE_CANARY_SCRIPTS,
  parseHeroVoiceCanaryManifest,
  parseHeroVoiceCanaryReferencePointer,
} from "../src/lib/hero-voice-canary-manifest";
import { parseHeroVoiceCanaryAudioRange } from "../src/lib/hero-voice-canary-range";
import { describeHeroVoiceCanaryWireRequest, prepareHeroVoiceCanaryWireRequest } from "../src/lib/hero-voice-canary-wire";
import {
  dryRunHeroVoiceCanary,
  parseHeroVoiceCanaryLedgerPayload,
  signHeroVoiceCanaryTask6EvidenceForTests,
} from "../src/lib/hero-voice-canary-ledger.server";

const APPROVED = [
  "วันนี้มิวอยากชวนทุกคนมาดูว่า AI ตัวนี้ช่วยให้เราทำงานเร็วขึ้นได้จริงแค่ไหน",
  "วันที่ 4 กันยายน 2026 เวลา 10 นาฬิกา 35 นาที ค่าใช้จ่ายทั้งหมดอยู่ที่ 1,249 บาท",
  "OpenAI, Gemini และ RunPod ทำหน้าที่ต่างกัน แต่สามารถเชื่อมต่อกันใน workflow เดียวได้",
  "ถ้าเราถามข้อมูลล่าสุด ระบบควรค้นหา ตรวจสอบแหล่งที่มา แล้วค่อยสรุปให้เราเข้าใจง่าย",
  "โอ้โห ผลลัพธ์รอบนี้ดีขึ้นชัดเจน แต่ยังต้องฟังคำควบกล้ำและปลายประโยคให้ละเอียดอีกครั้ง",
  "เรื่องยากไม่จำเป็นต้องเล่าให้ยาก เพราะเป้าหมายของมิวคือทำให้คนทั่วไปเห็นภาพและนำไปใช้ได้จริง",
] as const;

assert.deepEqual(HERO_VOICE_CANARY_SCRIPTS.map((script) => script.sourceText), APPROVED);
assert.equal(new Set(HERO_VOICE_CANARY_SCRIPTS.map((script) => script.sourceTextSha256)).size, 6);

assert.throws(() => parseHeroVoiceCanaryStrictJson(Buffer.from('{"x":1,"x":2}')));
assert.throws(() => parseHeroVoiceCanaryStrictJson(Buffer.from([0xff])));
assert.equal(heroVoiceCanaryJcsBytes({ z: 1, a: "ไทย" }).toString("utf8"), '{"a":"ไทย","z":1}');
assert.throws(() => heroVoiceCanaryJcsBytes({ invalid: Number.NaN }));
assert.throws(() => heroVoiceCanaryJcsBytes("\ud800"));
assert.throws(() => decodeHeroVoiceCanaryBase64url("YWJj="));
assert.equal(decodeHeroVoiceCanaryBase64url("YWJj").toString("utf8"), "abc");

const ikm = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const runId = "run-vector-0001";
const revealKey = deriveHeroVoiceCanaryRunKey(ikm, "reveal", runId);
const scoreKey = deriveHeroVoiceCanaryRunKey(ikm, "score", runId);
assert.notDeepEqual(revealKey, scoreKey);
assert.equal(revealKey.toString("hex"), "a845fb8da67adcd3438aac38cdf2f3a4bdc43842433991c14f1e613a277b8560");
assert.equal(heroVoiceCanaryHmacHex(scoreKey, { version: 1, value: "ไทย" }), "78978fe75434a3cfbae38b5622138296d9cb629b95f9cc1f832e9a6affef9f27");
const encrypted = encryptHeroVoiceCanaryReveal({
  key: revealKey,
  plaintext: { version: 1, secret: "synthetic" },
  aad: { version: 1, runId },
  nonce: Buffer.alloc(12, 7),
});
assert.equal(encrypted.envelopeBytes.toString("utf8"), '{"aadSha256":"896da9ca50b11dfcb3e7643dfd9285100693c3abb671cf26a566dd814a58f93f","alg":"A256GCM","ciphertext":"s-2LIYzSQJBHC-eUuMxnFMC1U_tsG2bOkPGwFR9WSvH1ww","nonce":"BwcHBwcHBwcHBwcH","tag":"JaZxtwkSWXUIkVUevmSNew","version":1}');
assert.deepEqual(decryptHeroVoiceCanaryReveal({
  key: revealKey,
  envelopeBytes: encrypted.envelopeBytes,
  aad: { version: 1, runId },
}).plaintext, Object.assign(Object.create(null), { secret: "synthetic", version: 1 }));
const tamperedEnvelope = Buffer.from(encrypted.envelopeBytes);
tamperedEnvelope[tamperedEnvelope.length - 3] ^= 1;
assert.throws(() => decryptHeroVoiceCanaryReveal({ key: revealKey, envelopeBytes: tamperedEnvelope, aad: { version: 1, runId } }));

const reference = Buffer.from("RIFF-synthetic-reference-WAVE", "utf8");
const evidenceSha256 = "e".repeat(64);
const built = buildHeroVoiceCanaryManifest({
  experimentId: "experiment-0001",
  referenceSha256: heroVoiceCanarySha256(reference),
  refTextSha256: heroVoiceCanarySha256(HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT),
  baseline: { endpointId: "baseline-endpoint", templateId: "baseline-template", imageDigest: `sha256:${"a".repeat(64)}` },
  candidate: {
    endpointId: "candidate-endpoint", templateId: "candidate-template", imageDigest: `sha256:${"b".repeat(64)}`,
    sourceRevision: "8b8eb9e3d31c9d47c91170bd2dc89d11f3c4e4bb", modelManifestSha256: "c".repeat(64),
  },
  rateUsdMicrosPerSecond: 100,
  nonGpuReserveComponents: [{ name: "registry", usdMicros: 1_000, evidenceSha256 }],
});
assert.deepEqual(parseHeroVoiceCanaryManifest(JSON.parse(built.manifestBytes.toString("utf8"))), built.manifest);
assert.equal(built.manifest.slots.length, 44);
assert.equal(built.manifest.slots[26].slotId, "final.candidate.script-01.repeat-01");
assert.equal(built.manifest.slots.filter((slot) => slot.phase === "ablation").length, 8);
assert.equal(built.manifest.slots.filter((slot) => slot.phase === "baseline").length, 18);
assert.equal(built.manifest.slots.filter((slot) => slot.phase === "candidate").length, 18);
assert.deepEqual(built.manifest.slots.map((slot) => slot.ordinal), Array.from({ length: 44 }, (_, index) => index + 1));
assert.deepEqual(built.manifest.slots.slice(0, 8).map((slot) => slot.slotId), [
  "ablation.reference-enhancement.control.script-01",
  "ablation.reference-enhancement.delta.script-01",
  "ablation.text-normalization.control.script-03",
  "ablation.text-normalization.delta.script-03",
  "ablation.guidance-ranking.control.script-05",
  "ablation.guidance-ranking.delta.script-05",
  "ablation.watermark.control.script-04",
  "ablation.watermark.delta.script-04",
]);
assert.deepEqual([...new Set(built.manifest.slots.filter((slot) => slot.phase === "candidate").map((slot) => slot.arm.seed))], [104729, 130363, 155921]);
assert.ok(built.manifest.slots.filter((slot) => slot.phase === "baseline").every((slot) => slot.arm.seed === null && slot.arm.seedSupport === "unsupported-v2"));
assert.equal(computeHeroVoiceCanaryCost({
  rateUsdMicrosPerSecond: 100,
  nonGpuReserveComponents: built.manifest.nonGpuReserveComponents,
  submittedReservedSlots: 20,
  remainingMandatorySlots: 24,
}).totalUpperBoundUsdMicros, 2_905_000);
for (let submittedReservedSlots = 0; submittedReservedSlots <= 44; submittedReservedSlots += 1) {
  const cost = computeHeroVoiceCanaryCost({
    rateUsdMicrosPerSecond: 100,
    nonGpuReserveComponents: built.manifest.nonGpuReserveComponents,
    submittedReservedSlots,
    remainingMandatorySlots: 44 - submittedReservedSlots,
  });
  assert.equal(cost.continuingUpperBoundUsdMicros, cost.totalUpperBoundUsdMicros);
}
assert.throws(() => computeHeroVoiceCanaryCost({
  rateUsdMicrosPerSecond: 1_000,
  nonGpuReserveComponents: built.manifest.nonGpuReserveComponents,
}));
assert.equal(dryRunHeroVoiceCanary({
  manifest: built.manifest,
  manifestSha256: built.manifestSha256,
}).mode, "dry-run");
assert.deepEqual(parseHeroVoiceCanaryLedgerPayload({
  type: "park_disposition", disposition: "confirmed", observedAtMs: 1,
}), { type: "park_disposition", disposition: "confirmed", observedAtMs: 1 });
assert.throws(() => parseHeroVoiceCanaryLedgerPayload({
  type: "park_disposition", disposition: "confirmed", observedAtMs: 1, secret: "forbidden",
}));
assert.throws(() => parseHeroVoiceCanaryLedgerPayload({
  type: "accepted_outcome", slotId: "slot-valid", outcome: "valid_completed",
  primaryStatus: "provider-private-status", cancelDisposition: "not_requested",
  audioSha256: "a".repeat(64), durationMs: 1, delayTimeMs: 0, executionTimeMs: 1, observedAtMs: 1,
}));
assert.throws(() => dryRunHeroVoiceCanary({
  manifest: built.manifest,
  manifestSha256: built.manifestSha256,
  apply: true,
}));
const task6Rows = [
  "billing-bound-660-seconds", "clerk-test-sessions", "control-peak-parity",
  "cost-rate-readback", "demucs-compatibility", "github-object-readback",
  "immutable-endpoint-readback", "legal-human-data", "license",
  "linux-arm64-evaluator", "meaningful-normalizer-delta",
].map((gate, index) => ({
  gate,
  evidenceSha256: heroVoiceCanarySha256(`evidence/${index}`),
  identitySha256: heroVoiceCanarySha256(`identity/${index}`),
  predicateSha256: heroVoiceCanarySha256(`predicate/${index}`),
}));
const nowMs = Date.now();
const syntheticTask6Unsigned = {
  version: 1,
  status: "approved",
  evidenceId: "synthetic-task6-evidence",
  manifestSha256: built.manifestSha256,
  issuedAtMs: nowMs - 1_000,
  expiresAtMs: nowMs + 60_000,
  rows: task6Rows,
};
const priorTask6Key = process.env.HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY;
process.env.HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY = Buffer.alloc(32, 7).toString("base64url");
const syntheticTask6EvidenceBytes = heroVoiceCanaryJcsBytes({
  ...syntheticTask6Unsigned,
  evidenceHmac: signHeroVoiceCanaryTask6EvidenceForTests(syntheticTask6Unsigned),
});
const syntheticTask6EvidenceSha256 = heroVoiceCanarySha256(syntheticTask6EvidenceBytes);
const priorTask6Gate = process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256;
process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = syntheticTask6EvidenceSha256;
assert.equal(dryRunHeroVoiceCanary({
  manifest: built.manifest,
  manifestSha256: built.manifestSha256,
  apply: true,
  task6EvidenceBytes: syntheticTask6EvidenceBytes,
  task6EvidenceSha256: syntheticTask6EvidenceSha256,
}).mode, "apply-authorized");
if (priorTask6Gate === undefined) delete process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256;
else process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256 = priorTask6Gate;
if (priorTask6Key === undefined) delete process.env.HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY;
else process.env.HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY = priorTask6Key;

assert.deepEqual(parseHeroVoiceCanaryReferencePointer({
  version: 1,
  sourceUri: "private://synthetic-reference",
  referenceSha256: built.manifest.referenceSha256,
  transcript: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  durationMs: 10_000,
}), {
  version: 1,
  sourceUri: "private://synthetic-reference",
  referenceSha256: built.manifest.referenceSha256,
  transcript: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  durationMs: 10_000,
});
assert.throws(() => parseHeroVoiceCanaryReferencePointer({
  version: 1, sourceUri: "private://bad", referenceSha256: built.manifest.referenceSha256,
  transcript: `${HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT}!`, durationMs: 10_000,
}));

for (const slot of [built.manifest.slots[0], built.manifest.slots[8], built.manifest.slots[26]]) {
  const prepared = prepareHeroVoiceCanaryWireRequest({ slot, referenceWav: reference, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT });
  assert.equal(prepared.wireRequestSha256, heroVoiceCanarySha256(prepared.bytes));
  assert.equal(prepared.descriptor.textSha256, slot.speechTextSha256);
  assert.equal(prepared.descriptor.matchedSettingsSha256, built.manifest.matchedSettingsSha256);
  const changed = Buffer.from(prepared.bytes.toString("utf8").replace('"speed":1', '"speed":2'));
  assert.throws(() => describeHeroVoiceCanaryWireRequest({
    bytes: changed,
    runnerKind: slot.runnerKind,
    endpointId: slot.endpointId,
    templateId: slot.templateId,
    imageDigest: slot.imageDigest,
    sourceRevision: slot.sourceRevision,
    modelManifestSha256: slot.modelManifestSha256,
    expectedWorkerVersion: slot.expectedWorkerVersion,
    expectedCatalogVersion: slot.expectedCatalogVersion,
  }));
}

const migration = fs.readFileSync("prisma/migrations/20260904100000_hero_voice_canary_task5_harness/migration.sql", "utf8");
assert.match(migration, /CanaryLedgerRecord_insert_sequence_guard/u);
assert.match(migration, /CanaryLedgerRecord_update_forbidden/u);
assert.match(migration, /CanaryLedgerRecord_delete_guard/u);
assert.match(migration, /ReviewRun_ledger_head_guard/u);
const generation = fs.readFileSync("src/lib/hero-voice-generation.server.ts", "utf8");
const transport = fs.readFileSync("src/lib/omnivoice.ts", "utf8");
const ordinaryRoute = fs.readFileSync("src/app/api/ai-studio/voices/route.ts", "utf8");
const submitRoute = fs.readFileSync("src/app/api/ai-studio/voice-clone-canary/runs/[runId]/slots/[slotId]/submit/route.ts", "utf8");
const client = fs.readFileSync("src/app/(dashboard)/ai-studio/voice-clone-canary/[runId]/ReviewClient.tsx", "utf8");
const authHarness = fs.readFileSync("src/lib/hero-voice-canary-auth.server.ts", "utf8");
const cli = fs.readFileSync("scripts/hero-voice-clone-canary.ts", "utf8");
assert.match(generation, /consumeHeroVoiceCanaryAdmissionInTransaction/u);
assert.match(generation, /commitHeroVoiceCanaryDispatchIntentWithinSerializedMutation/u);
assert.match(transport, /await input\.beforeDispatch\(input\.prepared\)/u);
assert.match(transport, /body: input\.prepared\.bytes/u);
assert.match(ordinaryRoute, /heroVoiceCanaryDeletionConfigured/u);
assert.doesNotMatch(submitRoute, /getCurrentUser\(/u);
assert.match(submitRoute, /authenticateHeroVoiceCanaryHttpRequest/u);
assert.match(authHarness, /\[nextExecutable, "start", "-H", "127\.0\.0\.1", "-p"/u);
assert.match(authHarness, /HERO_VOICE_CANARY_LOOPBACK_ATTESTATION_SHA256/u);
assert.match(authHarness, /request\.headers\.has\("forwarded"\)/u);
assert.doesNotMatch(authHarness, /headers\.get\(["']host["']\)/u);
assert.match(cli, /argument !== "--max-jobs=44" && argument !== "--budget-usd=10"/u);
assert.match(cli, /if \(argument === "--apply"\)/u);
assert.match(cli, /const runState = await runHeroVoiceCanaryApply\(\{/u);
assert.match(cli, /adapterFactory: task7Adapter/u);
assert.match(cli, /scripts\/hero-voice-clone-canary-task7-adapter\.ts/u);
for (const forbidden of [
  "endpointId", "imageDigest", "providerJobId", "experimentProfile", "slotManifestSha256",
  "baseline-v13", "combined-quality-v1", "comparisonKey", "audioSha256", "slotId",
]) {
  assert.doesNotMatch(client, new RegExp(forbidden, "u"));
}
assert.deepEqual(parseHeroVoiceCanaryAudioRange(null, 100), [0, 99]);
assert.deepEqual(parseHeroVoiceCanaryAudioRange("bytes=0-0", 100), [0, 0]);
assert.deepEqual(parseHeroVoiceCanaryAudioRange("bytes=90-999", 100), [90, 99]);
assert.deepEqual(parseHeroVoiceCanaryAudioRange("bytes=-10", 100), [90, 99]);
assert.deepEqual(parseHeroVoiceCanaryAudioRange("bytes=50-", 100), [50, 99]);
for (const invalidRange of ["bytes=", "bytes=100-101", "bytes=9-2", "bytes=0-1,4-5", "items=0-1"]) {
  assert.equal(parseHeroVoiceCanaryAudioRange(invalidRange, 100), null);
}
const reviewRoutes = ["route.ts", "audio/[token]/route.ts", "scores/[pairId]/route.ts", "lock/route.ts", "reveal/route.ts", "close/route.ts"];
for (const route of reviewRoutes) {
  const filename = path.join("src/app/api/ai-studio/voice-clone-canary/runs/[runId]", route);
  assert.ok(fs.existsSync(filename));
  const source = fs.readFileSync(filename, "utf8");
  assert.match(source, /dynamic = "force-dynamic"/u);
  assert.match(source, /heroVoiceClonePrivateJson/u);
  assert.match(source, /authenticateHeroVoiceCanaryHttpRequest/u);
  assert.doesNotMatch(source, /Content-Disposition|filename=/u);
}
const audioRoute = fs.readFileSync("src/app/api/ai-studio/voice-clone-canary/runs/[runId]/audio/[token]/route.ts", "utf8");
assert.match(audioRoute, /status: 416/u);
assert.match(audioRoute, /status: partial \? 206 : 200/u);
assert.match(audioRoute, /"Content-Range"/u);
assert.match(audioRoute, /"Accept-Ranges": "bytes"/u);
const nextConfig = fs.readFileSync("next.config.ts", "utf8");
assert.doesNotMatch(nextConfig, /productionBrowserSourceMaps\s*:\s*true/u);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hero-voice-canary-")));
const databasePath = path.join(root, "canary.sqlite");
const voiceRoot = path.join(root, "references");
const reviewRoot = path.join(root, "review");
fs.mkdirSync(voiceRoot, { mode: 0o700 });
fs.mkdirSync(reviewRoot, { mode: 0o700 });
const authIssuer = "https://synthetic.clerk.accounts.dev";
const authSubject = "user_synthetic_task5";
const authAttestationPath = path.join(root, "auth-attestation.json");
const authAttestationBytes = heroVoiceCanaryJcsBytes({
  audience: "hero-voice-clone-canary-v1",
  issuerSha256: heroVoiceCanarySha256(authIssuer),
  sessionCount: 2,
  subjectSha256: heroVoiceCanarySha256(authSubject),
  testKeys: true,
  version: 1,
});
fs.writeFileSync(authAttestationPath, authAttestationBytes, { mode: 0o600 });
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: `file:${databasePath}?connection_limit=1`,
  HERO_VOICE_CANARY_EXECUTION_MODE: "1",
  HERO_VOICE_CANARY_ROOT: root,
  HERO_VOICE_CANARY_REVIEW_ROOT: reviewRoot,
  HERO_VOICE_CANARY_REVIEW_KEY: Buffer.alloc(32, 9).toString("base64url"),
  HERO_VOICE_CANARY_AUTH_ISSUER: authIssuer,
  HERO_VOICE_CANARY_AUTH_SUBJECT: authSubject,
  HERO_VOICE_CANARY_AUTH_AUDIENCE: "hero-voice-clone-canary-v1",
  HERO_VOICE_CANARY_AUTH_ATTESTATION_PATH: authAttestationPath,
  HERO_VOICE_CANARY_AUTH_ATTESTATION_SHA256: heroVoiceCanarySha256(authAttestationBytes),
  HERO_VOICE_CANARY_LISTEN_HOST: "127.0.0.1",
  HERO_VOICE_CANARY_EXTERNAL_BILLING_DISABLED: "1",
  HERO_VOICE_CANARY_WEBHOOKS_DISABLED: "1",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_synthetic_task5",
  CLERK_SECRET_KEY: "sk_test_synthetic_task5",
  OMNIVOICE_ENABLED: "1",
  HERO_VOICE_CLONING_ENABLED: "1",
  OMNIVOICE_ALLOWED_USER_IDS: "*",
  INTERNAL_AI_ALLOWED_EMAILS: "hero-voice-task5@test.invalid",
  HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY: Buffer.alloc(32, 8).toString("base64url"),
  HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY: Buffer.alloc(32, 7).toString("base64url"),
  USER_VOICE_STORAGE_DIR: voiceRoot,
};
try {
  const migrated = spawnSync("npx", ["prisma", "migrate", "deploy"], { cwd: process.cwd(), env, encoding: "utf8" });
  if (migrated.status !== 0) {
    process.stderr.write(migrated.stdout); process.stderr.write(migrated.stderr); process.exit(migrated.status ?? 1);
  }
  const pushed = spawnSync("npx", ["prisma", "db", "push", "--skip-generate"], { cwd: process.cwd(), env, encoding: "utf8" });
  if (pushed.status !== 0) {
    process.stderr.write(pushed.stdout); process.stderr.write(pushed.stderr); process.exit(pushed.status ?? 1);
  }
  fs.chmodSync(databasePath, 0o600);
  const runtime = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/verify-hero-voice-canary-runtime.ts"], {
    cwd: process.cwd(), env, encoding: "utf8",
  });
  process.stdout.write(runtime.stdout); process.stderr.write(runtime.stderr);
  if (runtime.status !== 0) process.exit(runtime.status ?? 1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Hero Voice Task 5 canary manifest/crypto/wire/ledger/admission/review contract verified.");
