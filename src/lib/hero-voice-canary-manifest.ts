import { heroVoiceCanaryJcsBytes, heroVoiceCanarySha256 } from "@/lib/hero-voice-canary-canonical";

export const HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT =
  "ถ้าเราใช้ตัว AI ในสมัยก่อน เวลาเราถามอะไรที่ปัจจุบัน หรือว่า ตอนนี้ เช่น วันนี้ อุณหภูมิเท่าไหร่";
export const HERO_VOICE_CANARY_NORMALIZER_NAME = "hero-voice-speech" as const;
export const HERO_VOICE_CANARY_NORMALIZER_VERSION = "2026-09-04.canary.1" as const;
export const HERO_VOICE_CANARY_NORMALIZER_SOURCE_REVISION =
  "task5-frozen-script3-transliteration-v1@f4c763a5" as const;
export const HERO_VOICE_CANARY_WORKER_VERSION =
  "hero-voice-clone-contract-v3-internal-eval-2" as const;
export const HERO_VOICE_CANARY_BASELINE_WORKER_VERSION = "hero-voice-ai-v2-565d0e6" as const;
export const HERO_VOICE_CANARY_BASELINE_CATALOG_VERSION = "hero-voice-ai-v2-2026-08-24" as const;
export const HERO_VOICE_CANARY_MAX_JOBS = 44 as const;
export const HERO_VOICE_CANARY_BUDGET_USD_MICROS = 10_000_000 as const;
export const HERO_VOICE_CANARY_SLOT_RESERVE_SECONDS = 660 as const;
export const HERO_VOICE_CANARY_REFERENCE_POINTER_PATH = ".tmp/hero-voice-clone-canary-reference.json" as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+/@:-]{0,127}$/u;

export type HeroVoiceCanaryScriptId = `script-0${1 | 2 | 3 | 4 | 5 | 6}`;
export type HeroVoiceCanaryRepeatId = `repeat-0${1 | 2 | 3}`;
export type HeroVoiceCanaryProfile =
  | "control-v1"
  | "reference-enhancement-v1"
  | "text-normalization-v1"
  | "guidance-ranking-v1"
  | "watermark-v1"
  | "combined-quality-v1";
export type HeroVoiceCanaryRunnerKind =
  | "BaselineV13Direct"
  | "CandidateExperimentV3Direct"
  | "CandidateAiStudioV3";

export type HeroVoiceCanaryScript = Readonly<{
  scriptId: HeroVoiceCanaryScriptId;
  sourceText: string;
  sourceTextSha256: string;
  speechText: string;
  speechTextSha256: string;
  normalizerName: typeof HERO_VOICE_CANARY_NORMALIZER_NAME;
  normalizerVersion: typeof HERO_VOICE_CANARY_NORMALIZER_VERSION;
  normalizerSourceRevision: typeof HERO_VOICE_CANARY_NORMALIZER_SOURCE_REVISION;
}>;

export type HeroVoiceCanaryReferencePointer = Readonly<{
  version: 1;
  sourceUri: string;
  referenceSha256: string;
  transcript: typeof HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT;
  durationMs: 10_000;
}>;

export function parseHeroVoiceCanaryReferencePointer(value: unknown): HeroVoiceCanaryReferencePointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canary_reference_pointer_invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["durationMs", "referenceSha256", "sourceUri", "transcript", "version"])
    || record.version !== 1 || typeof record.sourceUri !== "string" || record.sourceUri.length < 8 || record.sourceUri.length > 2_048
    || typeof record.referenceSha256 !== "string" || !HEX64.test(record.referenceSha256)
    || record.transcript !== HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT || record.durationMs !== 10_000) {
    throw new Error("canary_reference_pointer_invalid");
  }
  return Object.freeze(record as unknown as HeroVoiceCanaryReferencePointer);
}

const APPROVED_SCRIPT_TEXTS = Object.freeze([
  "วันนี้มิวอยากชวนทุกคนมาดูว่า AI ตัวนี้ช่วยให้เราทำงานเร็วขึ้นได้จริงแค่ไหน",
  "วันที่ 4 กันยายน 2026 เวลา 10 นาฬิกา 35 นาที ค่าใช้จ่ายทั้งหมดอยู่ที่ 1,249 บาท",
  "OpenAI, Gemini และ RunPod ทำหน้าที่ต่างกัน แต่สามารถเชื่อมต่อกันใน workflow เดียวได้",
  "ถ้าเราถามข้อมูลล่าสุด ระบบควรค้นหา ตรวจสอบแหล่งที่มา แล้วค่อยสรุปให้เราเข้าใจง่าย",
  "โอ้โห ผลลัพธ์รอบนี้ดีขึ้นชัดเจน แต่ยังต้องฟังคำควบกล้ำและปลายประโยคให้ละเอียดอีกครั้ง",
  "เรื่องยากไม่จำเป็นต้องเล่าให้ยาก เพราะเป้าหมายของมิวคือทำให้คนทั่วไปเห็นภาพและนำไปใช้ได้จริง",
] as const);

const SCRIPT_03_NORMALIZED =
  "โอเพนเอไอ, เจมิไน และ รันพ็อด ทำหน้าที่ต่างกัน แต่สามารถเชื่อมต่อกันใน เวิร์กโฟลว์ เดียวได้" as const;

/** Frozen, local, deterministic treatment used only by the declared
 * text-normalization ablation. It has no network/provider/library fallback. */
export function normalizeHeroVoiceCanaryScript03(sourceText: string): typeof SCRIPT_03_NORMALIZED {
  if (sourceText !== APPROVED_SCRIPT_TEXTS[2]) throw new Error("canary_normalizer_source_invalid");
  return SCRIPT_03_NORMALIZED;
}

const APPROVED_SPEECH_TEXTS = Object.freeze([
  "วันนี้มิวอยากชวนทุกคนมาดูว่า เอไอ ตัวนี้ช่วยให้เราทำงานเร็วขึ้นได้จริงแค่ไหน",
  "วันที่ สี่ กันยายน สองพันยี่สิบหก เวลา สิบ นาฬิกา สามสิบห้า นาที ค่าใช้จ่ายทั้งหมดอยู่ที่ หนึ่งพันสองร้อยสี่สิบเก้าบาท",
  normalizeHeroVoiceCanaryScript03(APPROVED_SCRIPT_TEXTS[2]),
  "ถ้าเราถามข้อมูลล่าสุด ระบบควรค้นหา ตรวจสอบแหล่งที่มา แล้วค่อยสรุปให้เราเข้าใจง่าย",
  "โอ้โห ผลลัพธ์รอบนี้ดีขึ้นชัดเจน แต่ยังต้องฟังคำควบกล้ำและปลายประโยคให้ละเอียดอีกครั้ง",
  "เรื่องยากไม่จำเป็นต้องเล่าให้ยาก เพราะเป้าหมายของมิวคือทำให้คนทั่วไปเห็นภาพและนำไปใช้ได้จริง",
] as const);

export const HERO_VOICE_CANARY_SCRIPTS: readonly HeroVoiceCanaryScript[] = Object.freeze(
  APPROVED_SCRIPT_TEXTS.map((sourceText, index) => {
    const speechText = APPROVED_SPEECH_TEXTS[index];
    return Object.freeze({
      scriptId: `script-0${index + 1}` as HeroVoiceCanaryScriptId,
      sourceText,
      sourceTextSha256: heroVoiceCanarySha256(sourceText),
      speechText,
      speechTextSha256: heroVoiceCanarySha256(speechText),
      normalizerName: HERO_VOICE_CANARY_NORMALIZER_NAME,
      normalizerVersion: HERO_VOICE_CANARY_NORMALIZER_VERSION,
      normalizerSourceRevision: HERO_VOICE_CANARY_NORMALIZER_SOURCE_REVISION,
    });
  }),
);

export const HERO_VOICE_CANARY_MATCHED_SETTINGS = Object.freeze({
  speed: 1,
  numStep: 32,
  mixedLanguage: true,
  outputRate: 24_000,
  outputChannels: 1,
  outputSubtype: "PCM_16" as const,
});

export const HERO_VOICE_CANARY_MATCHED_SETTINGS_SHA256 = heroVoiceCanarySha256(
  heroVoiceCanaryJcsBytes(HERO_VOICE_CANARY_MATCHED_SETTINGS),
);

export type HeroVoiceCanaryArmFields = Readonly<{
  contractVersion: 2 | 3;
  seedSupport: "unsupported-v2" | "explicit-v3";
  seed: number | null;
  profile: HeroVoiceCanaryProfile | "baseline-v13";
  guidance: number | null;
  candidateCount: number;
  temperature: number;
  ranking: "speaker-cosine-max" | "speaker-cosine-plus-0.15-pitch";
  watermark: "none" | "audioseal-v1";
  referenceTreatment: "audited-v13-reference" | "demucs-then-peak-0.95";
}>;

export type HeroVoiceCanarySlot = Readonly<{
  ordinal: number;
  slotId: string;
  phase: "ablation" | "baseline" | "candidate";
  runnerKind: HeroVoiceCanaryRunnerKind;
  scriptId: HeroVoiceCanaryScriptId;
  repeatId: HeroVoiceCanaryRepeatId | null;
  comparisonKey: string | null;
  smoke: boolean;
  endpointId: string;
  templateId: string;
  imageDigest: string;
  sourceRevision: string;
  modelManifestSha256: string;
  expectedWorkerVersion: string;
  expectedCatalogVersion: string | null;
  sourceTextSha256: string;
  speechTextKind: "source" | "normalized";
  speechTextSha256: string;
  referenceSha256: string;
  refTextSha256: string;
  normalizerName: string;
  normalizerVersion: string;
  normalizerSourceRevision: string;
  matchedSettings: typeof HERO_VOICE_CANARY_MATCHED_SETTINGS;
  matchedSettingsSha256: string;
  arm: HeroVoiceCanaryArmFields;
  requestCommitmentSha256: string | null;
  policy: Readonly<{ executionTimeout: 540_000; ttl: 900_000 }>;
  costReserve: Readonly<{ seconds: 660; rateUsdMicrosPerSecond: number; usdMicros: number }>;
}>;

export type HeroVoiceCanaryManifest = Readonly<{
  version: 1;
  experimentId: string;
  referenceSha256: string;
  refTextSha256: string;
  scripts: readonly HeroVoiceCanaryScript[];
  matchedSettings: typeof HERO_VOICE_CANARY_MATCHED_SETTINGS;
  matchedSettingsSha256: string;
  identities: Readonly<{
    baseline: Readonly<{ endpointId: string; templateId: string; imageDigest: string }>;
    candidate: Readonly<{
      endpointId: string;
      templateId: string;
      imageDigest: string;
      sourceRevision: string;
      modelManifestSha256: string;
    }>;
  }>;
  slots: readonly HeroVoiceCanarySlot[];
  maxJobs: 44;
  budgetUsdMicros: 10_000_000;
  rateUsdMicrosPerSecond: number;
  nonGpuReserveComponents: readonly Readonly<{ name: string; usdMicros: number; evidenceSha256: string }>[];
  nonGpuReserveUsdMicros: number;
  gpuReserveUsdMicros: number;
  totalUpperBoundUsdMicros: number;
}>;

function assertIdentity(input: {
  endpointId: string;
  templateId: string;
  imageDigest: string;
}): void {
  if (!SAFE_PROVIDER_ID.test(input.endpointId) || !SAFE_PROVIDER_ID.test(input.templateId)
    || !OCI_DIGEST.test(input.imageDigest)) throw new Error("canary_identity_invalid");
}

function requestCommitment(input: {
  referenceSha256: string;
  refTextSha256: string;
  textSha256: string;
  seed: number;
  profile: HeroVoiceCanaryProfile;
}): string {
  return heroVoiceCanarySha256(heroVoiceCanaryJcsBytes({
    contractVersion: 3,
    mode: "clone",
    refAudioSha256: input.referenceSha256,
    refTextSha256: input.refTextSha256,
    textSha256: input.textSha256,
    speed: 1,
    numStep: 32,
    mixedLanguage: true,
    seed: input.seed,
    experimentProfile: input.profile,
    normalizerVersion: HERO_VOICE_CANARY_NORMALIZER_VERSION,
  }));
}

function armFor(profile: HeroVoiceCanaryProfile | "baseline-v13", seed: number | null): HeroVoiceCanaryArmFields {
  if (profile === "baseline-v13") {
    return Object.freeze({
      contractVersion: 2, seedSupport: "unsupported-v2", seed: null, profile,
      guidance: 2.5, candidateCount: 3, temperature: 0.8,
      ranking: "speaker-cosine-max", watermark: "none", referenceTreatment: "audited-v13-reference",
    });
  }
  const ranked = profile === "guidance-ranking-v1" || profile === "combined-quality-v1";
  const enhanced = profile === "reference-enhancement-v1" || profile === "combined-quality-v1";
  return Object.freeze({
    contractVersion: 3, seedSupport: "explicit-v3", seed, profile,
    guidance: ranked ? 2 : 2.5, candidateCount: 3, temperature: 0.8,
    ranking: ranked ? "speaker-cosine-plus-0.15-pitch" : "speaker-cosine-max",
    watermark: profile === "watermark-v1" ? "audioseal-v1" : "none",
    referenceTreatment: enhanced ? "demucs-then-peak-0.95" : "audited-v13-reference",
  });
}

function checkedMicros(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}_invalid`);
  return value;
}

export function computeHeroVoiceCanaryCost(input: {
  rateUsdMicrosPerSecond: number;
  nonGpuReserveComponents: readonly { name: string; usdMicros: number; evidenceSha256: string }[];
  submittedReservedSlots?: number;
  remainingMandatorySlots?: number;
}): Readonly<{
  gpuReserveUsdMicros: number;
  nonGpuReserveUsdMicros: number;
  totalUpperBoundUsdMicros: number;
  continuingUpperBoundUsdMicros: number;
}> {
  const rate = checkedMicros(input.rateUsdMicrosPerSecond, "canary_rate");
  if (rate === 0) throw new Error("canary_rate_requires_authoritative_nonzero_readback");
  const seen = new Set<string>();
  const nonGpuReserveUsdMicros = input.nonGpuReserveComponents.reduce((sum, component) => {
    if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(component.name) || seen.has(component.name)
      || !HEX64.test(component.evidenceSha256)) throw new Error("canary_non_gpu_component_invalid");
    seen.add(component.name);
    return checkedMicros(sum + checkedMicros(component.usdMicros, "canary_non_gpu_component"), "canary_non_gpu_total");
  }, 0);
  const perSlot = checkedMicros(rate * HERO_VOICE_CANARY_SLOT_RESERVE_SECONDS, "canary_slot_reserve");
  const gpuReserveUsdMicros = checkedMicros(perSlot * HERO_VOICE_CANARY_MAX_JOBS, "canary_gpu_reserve");
  const totalUpperBoundUsdMicros = checkedMicros(gpuReserveUsdMicros + nonGpuReserveUsdMicros, "canary_total");
  const submitted = input.submittedReservedSlots ?? 0;
  const remaining = input.remainingMandatorySlots ?? HERO_VOICE_CANARY_MAX_JOBS;
  if (!Number.isSafeInteger(submitted) || !Number.isSafeInteger(remaining)
    || submitted < 0 || remaining < 0 || submitted + remaining > HERO_VOICE_CANARY_MAX_JOBS) {
    throw new Error("canary_cost_partition_invalid");
  }
  const continuingUpperBoundUsdMicros = checkedMicros(
    (submitted + remaining) * perSlot + nonGpuReserveUsdMicros,
    "canary_continuing_total",
  );
  if (totalUpperBoundUsdMicros > HERO_VOICE_CANARY_BUDGET_USD_MICROS
    || continuingUpperBoundUsdMicros > HERO_VOICE_CANARY_BUDGET_USD_MICROS) {
    throw new Error("canary_budget_exceeded");
  }
  return Object.freeze({ gpuReserveUsdMicros, nonGpuReserveUsdMicros, totalUpperBoundUsdMicros, continuingUpperBoundUsdMicros });
}

export function buildHeroVoiceCanaryManifest(input: {
  experimentId: string;
  referenceSha256: string;
  refTextSha256: string;
  baseline: { endpointId: string; templateId: string; imageDigest: string };
  candidate: {
    endpointId: string;
    templateId: string;
    imageDigest: string;
    sourceRevision: string;
    modelManifestSha256: string;
  };
  rateUsdMicrosPerSecond: number;
  nonGpuReserveComponents: readonly { name: string; usdMicros: number; evidenceSha256: string }[];
}): { manifest: HeroVoiceCanaryManifest; manifestBytes: Buffer; manifestSha256: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/u.test(input.experimentId)
    || !HEX64.test(input.referenceSha256) || !HEX64.test(input.refTextSha256)) {
    throw new Error("canary_manifest_identity_invalid");
  }
  assertIdentity(input.baseline);
  assertIdentity(input.candidate);
  if (!SAFE_VERSION.test(input.candidate.sourceRevision) || !HEX64.test(input.candidate.modelManifestSha256)) {
    throw new Error("canary_candidate_identity_invalid");
  }
  const cost = computeHeroVoiceCanaryCost(input);
  const perSlotUsdMicros = input.rateUsdMicrosPerSecond * HERO_VOICE_CANARY_SLOT_RESERVE_SECONDS;
  const slots: HeroVoiceCanarySlot[] = [];
  const append = (slot: Omit<HeroVoiceCanarySlot, "ordinal" | "costReserve" | "policy">): void => {
    slots.push(Object.freeze({
      ...slot,
      ordinal: slots.length + 1,
      policy: Object.freeze({ executionTimeout: 540_000 as const, ttl: 900_000 as const }),
      costReserve: Object.freeze({
        seconds: HERO_VOICE_CANARY_SLOT_RESERVE_SECONDS,
        rateUsdMicrosPerSecond: input.rateUsdMicrosPerSecond,
        usdMicros: perSlotUsdMicros,
      }),
    }));
  };
  const common = (script: HeroVoiceCanaryScript, speechTextKind: "source" | "normalized") => ({
    scriptId: script.scriptId,
    sourceTextSha256: script.sourceTextSha256,
    speechTextKind,
    speechTextSha256: speechTextKind === "source" ? script.sourceTextSha256 : script.speechTextSha256,
    referenceSha256: input.referenceSha256,
    refTextSha256: input.refTextSha256,
    normalizerName: script.normalizerName,
    normalizerVersion: script.normalizerVersion,
    normalizerSourceRevision: script.normalizerSourceRevision,
    matchedSettings: HERO_VOICE_CANARY_MATCHED_SETTINGS,
    matchedSettingsSha256: HERO_VOICE_CANARY_MATCHED_SETTINGS_SHA256,
  });
  const ablations: readonly [HeroVoiceCanaryProfile, HeroVoiceCanaryScriptId, number][] = [
    ["reference-enhancement-v1", "script-01", 20_260_901],
    ["text-normalization-v1", "script-03", 20_260_902],
    ["guidance-ranking-v1", "script-05", 20_260_903],
    ["watermark-v1", "script-04", 20_260_904],
  ];
  for (const [deltaProfile, scriptId, seed] of ablations) {
    const script = HERO_VOICE_CANARY_SCRIPTS.find((item) => item.scriptId === scriptId)!;
    const comparison = deltaProfile.replace(/-v1$/u, "");
    for (const profile of ["control-v1", deltaProfile] as const) {
      const speechTextKind = deltaProfile === "text-normalization-v1" && profile === "control-v1"
        ? "source" as const : "normalized" as const;
      const arm = armFor(profile, seed);
      const textSha256 = speechTextKind === "source" ? script.sourceTextSha256 : script.speechTextSha256;
      append({
        ...common(script, speechTextKind),
        slotId: `ablation.${comparison}.${profile === "control-v1" ? "control" : "delta"}.${scriptId}`,
        phase: "ablation", runnerKind: "CandidateExperimentV3Direct", repeatId: null,
        comparisonKey: `ablation/${comparison}`, smoke: false,
        endpointId: input.candidate.endpointId, templateId: input.candidate.templateId,
        imageDigest: input.candidate.imageDigest, sourceRevision: input.candidate.sourceRevision,
        modelManifestSha256: input.candidate.modelManifestSha256,
        expectedWorkerVersion: HERO_VOICE_CANARY_WORKER_VERSION, expectedCatalogVersion: null,
        arm,
        requestCommitmentSha256: requestCommitment({
          referenceSha256: input.referenceSha256, refTextSha256: input.refTextSha256,
          textSha256, seed, profile,
        }),
      });
    }
  }
  const repeats = ["repeat-01", "repeat-02", "repeat-03"] as const;
  for (const script of HERO_VOICE_CANARY_SCRIPTS) {
    for (const repeatId of repeats) {
      append({
        ...common(script, "normalized"),
        slotId: `final.baseline.${script.scriptId}.${repeatId}`,
        phase: "baseline", runnerKind: "BaselineV13Direct", repeatId,
        comparisonKey: `${script.scriptId}/${repeatId}`, smoke: false,
        endpointId: input.baseline.endpointId, templateId: input.baseline.templateId,
        imageDigest: input.baseline.imageDigest, sourceRevision: "audited-v13-565d0e6",
        modelManifestSha256: heroVoiceCanarySha256(HERO_VOICE_CANARY_BASELINE_CATALOG_VERSION),
        expectedWorkerVersion: HERO_VOICE_CANARY_BASELINE_WORKER_VERSION,
        expectedCatalogVersion: HERO_VOICE_CANARY_BASELINE_CATALOG_VERSION,
        arm: armFor("baseline-v13", null), requestCommitmentSha256: null,
      });
    }
  }
  const finalSeeds = [104_729, 130_363, 155_921] as const;
  for (const script of HERO_VOICE_CANARY_SCRIPTS) {
    for (const [repeatIndex, repeatId] of repeats.entries()) {
      const seed = finalSeeds[repeatIndex];
      const arm = armFor("combined-quality-v1", seed);
      append({
        ...common(script, "normalized"),
        slotId: `final.candidate.${script.scriptId}.${repeatId}`,
        phase: "candidate", runnerKind: "CandidateAiStudioV3", repeatId,
        comparisonKey: `${script.scriptId}/${repeatId}`,
        smoke: script.scriptId === "script-01" && repeatId === "repeat-01",
        endpointId: input.candidate.endpointId, templateId: input.candidate.templateId,
        imageDigest: input.candidate.imageDigest, sourceRevision: input.candidate.sourceRevision,
        modelManifestSha256: input.candidate.modelManifestSha256,
        expectedWorkerVersion: HERO_VOICE_CANARY_WORKER_VERSION, expectedCatalogVersion: null,
        arm,
        requestCommitmentSha256: requestCommitment({
          referenceSha256: input.referenceSha256, refTextSha256: input.refTextSha256,
          textSha256: script.speechTextSha256, seed, profile: "combined-quality-v1",
        }),
      });
    }
  }
  if (slots.length !== 44 || slots[26]?.slotId !== "final.candidate.script-01.repeat-01"
    || slots.filter((slot) => slot.smoke).length !== 1
    || new Set(slots.map((slot) => slot.slotId)).size !== 44
    || HERO_VOICE_CANARY_SCRIPTS[2].sourceTextSha256 === HERO_VOICE_CANARY_SCRIPTS[2].speechTextSha256
    || HERO_VOICE_CANARY_SCRIPTS[2].speechText !== normalizeHeroVoiceCanaryScript03(HERO_VOICE_CANARY_SCRIPTS[2].sourceText)) {
    throw new Error("canary_slot_inventory_invalid");
  }
  const components = input.nonGpuReserveComponents.map((component) => Object.freeze({ ...component }));
  const manifest: HeroVoiceCanaryManifest = Object.freeze({
    version: 1,
    experimentId: input.experimentId,
    referenceSha256: input.referenceSha256,
    refTextSha256: input.refTextSha256,
    scripts: HERO_VOICE_CANARY_SCRIPTS,
    matchedSettings: HERO_VOICE_CANARY_MATCHED_SETTINGS,
    matchedSettingsSha256: HERO_VOICE_CANARY_MATCHED_SETTINGS_SHA256,
    identities: Object.freeze({
      baseline: Object.freeze({ ...input.baseline }),
      candidate: Object.freeze({ ...input.candidate }),
    }),
    slots: Object.freeze(slots),
    maxJobs: HERO_VOICE_CANARY_MAX_JOBS,
    budgetUsdMicros: HERO_VOICE_CANARY_BUDGET_USD_MICROS,
    rateUsdMicrosPerSecond: input.rateUsdMicrosPerSecond,
    nonGpuReserveComponents: Object.freeze(components),
    nonGpuReserveUsdMicros: cost.nonGpuReserveUsdMicros,
    gpuReserveUsdMicros: cost.gpuReserveUsdMicros,
    totalUpperBoundUsdMicros: cost.totalUpperBoundUsdMicros,
  });
  const manifestBytes = heroVoiceCanaryJcsBytes(manifest);
  return { manifest, manifestBytes, manifestSha256: heroVoiceCanarySha256(manifestBytes) };
}

export function parseHeroVoiceCanaryManifest(value: unknown): HeroVoiceCanaryManifest {
  const bytes = heroVoiceCanaryJcsBytes(value);
  const parsed = JSON.parse(bytes.toString("utf8")) as HeroVoiceCanaryManifest;
  const rebuilt = buildHeroVoiceCanaryManifest({
    experimentId: parsed.experimentId,
    referenceSha256: parsed.referenceSha256,
    refTextSha256: parsed.refTextSha256,
    baseline: parsed.identities?.baseline,
    candidate: parsed.identities?.candidate,
    rateUsdMicrosPerSecond: parsed.rateUsdMicrosPerSecond,
    nonGpuReserveComponents: parsed.nonGpuReserveComponents,
  });
  if (!bytes.equals(rebuilt.manifestBytes)) throw new Error("canary_manifest_invalid");
  return rebuilt.manifest;
}

export function speechTextForHeroVoiceCanarySlot(slot: HeroVoiceCanarySlot): string {
  const script = HERO_VOICE_CANARY_SCRIPTS.find((item) => item.scriptId === slot.scriptId);
  if (!script) throw new Error("canary_script_missing");
  return slot.speechTextKind === "source" ? script.sourceText : script.speechText;
}
