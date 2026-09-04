import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseHeroVoiceCanaryStrictJson, heroVoiceCanaryJcsBytes, heroVoiceCanarySha256 } from "../src/lib/hero-voice-canary-canonical";
import { dryRunHeroVoiceCanary, HeroVoiceCanaryLedgerError } from "../src/lib/hero-voice-canary-ledger.server";
import { runHeroVoiceCanaryApply, type HeroVoiceCanaryApplyAdapter } from "../src/lib/hero-voice-canary-runner.server";
import { HeroVoiceCanaryTask7AdapterProcess } from "../src/lib/hero-voice-canary-task7-adapter-process.server";
import { computeHeroVoiceCanaryOwnerHmac } from "../src/lib/hero-voice-deletion-coordinator.server";
import {
  buildHeroVoiceCanaryManifest,
  HERO_VOICE_CANARY_REFERENCE_POINTER_PATH,
  parseHeroVoiceCanaryReferencePointer,
} from "../src/lib/hero-voice-canary-manifest";
import { loadHeroVoiceCanaryReference } from "../src/lib/hero-voice-canary-reference.server";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function parseArguments(argv: readonly string[]): { apply: boolean } {
  let apply = false;
  const seen = new Set<string>();
  for (const argument of argv) {
    if (seen.has(argument)) throw new Error("duplicate_canary_flag");
    seen.add(argument);
    if (argument === "--apply") apply = true;
    else if (argument !== "--max-jobs=44" && argument !== "--budget-usd=10") throw new Error("invalid_canary_flag");
  }
  return { apply };
}

function referencePointer() {
  const filename = path.resolve(process.cwd(), HERO_VOICE_CANARY_REFERENCE_POINTER_PATH);
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("reference_pointer_permissions_invalid");
  }
  const ignored = execFileSync("git", ["check-ignore", "--quiet", "--", HERO_VOICE_CANARY_REFERENCE_POINTER_PATH], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  void ignored;
  const bytes = fs.readFileSync(filename);
  const parsed = parseHeroVoiceCanaryStrictJson(bytes);
  if (!heroVoiceCanaryJcsBytes(parsed).equals(bytes)) throw new Error("reference_pointer_not_canonical");
  return parseHeroVoiceCanaryReferencePointer(parsed);
}

function nonGpuComponents(): readonly { name: string; usdMicros: number; evidenceSha256: string }[] {
  const bytes = Buffer.from(required("HERO_VOICE_CANARY_NON_GPU_RESERVE_COMPONENTS_JCS"), "utf8");
  const parsed = parseHeroVoiceCanaryStrictJson(bytes);
  if (!heroVoiceCanaryJcsBytes(parsed).equals(bytes) || !Array.isArray(parsed)) {
    throw new Error("non_gpu_reserve_invalid");
  }
  return parsed as readonly { name: string; usdMicros: number; evidenceSha256: string }[];
}

function task6Evidence(): { bytes?: Buffer; sha256?: string } {
  const filename = process.env.HERO_VOICE_CANARY_TASK6_EVIDENCE_FILE;
  const sha256 = process.env.HERO_VOICE_CANARY_TASK6_GATE_SHA256;
  if (!filename && !sha256) return {};
  if (!filename || !sha256 || !path.isAbsolute(filename)) throw new Error("task6_evidence_invalid");
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("task6_evidence_invalid");
  }
  return { bytes: fs.readFileSync(filename), sha256 };
}

async function task7Adapter(): Promise<HeroVoiceCanaryApplyAdapter> {
  // Task 7 owns this checked-in adapter module. Keeping the path fixed prevents
  // an apply invocation from loading arbitrary credential-bearing code.
  const filename = path.resolve(process.cwd(), "scripts/hero-voice-clone-canary-task7-adapter.ts");
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("task7_adapter_invalid");
  }
  return new HeroVoiceCanaryTask7AdapterProcess();
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const pointer = referencePointer();
  const reference = loadHeroVoiceCanaryReference({
    pointer,
    expectedSha256: required("HERO_VOICE_CANARY_EXPECTED_REFERENCE_SHA256"),
  });
  const rate = Number(required("HERO_VOICE_CANARY_RATE_USD_MICROS_PER_SECOND"));
  const built = buildHeroVoiceCanaryManifest({
    experimentId: required("HERO_VOICE_CANARY_EXPERIMENT_ID"),
    referenceSha256: reference.sha256,
    refTextSha256: heroVoiceCanarySha256(pointer.transcript),
    baseline: {
      endpointId: required("HERO_VOICE_CANARY_BASELINE_ENDPOINT_ID"),
      templateId: required("HERO_VOICE_CANARY_BASELINE_TEMPLATE_ID"),
      imageDigest: required("HERO_VOICE_CANARY_BASELINE_IMAGE_DIGEST"),
    },
    candidate: {
      endpointId: required("HERO_VOICE_CANARY_CANDIDATE_ENDPOINT_ID"),
      templateId: required("HERO_VOICE_CANARY_CANDIDATE_TEMPLATE_ID"),
      imageDigest: required("RUNPOD_HERO_VOICE_CLONE_IMAGE_DIGEST"),
      sourceRevision: required("RUNPOD_HERO_VOICE_CLONE_SOURCE_REVISION"),
      modelManifestSha256: required("RUNPOD_HERO_VOICE_CLONE_MODEL_MANIFEST_SHA256"),
    },
    rateUsdMicrosPerSecond: rate,
    nonGpuReserveComponents: nonGpuComponents(),
  });
  const evidence = task6Evidence();
  const result = dryRunHeroVoiceCanary({
    manifest: built.manifest,
    manifestSha256: built.manifestSha256,
    apply: options.apply,
    task6EvidenceBytes: evidence.bytes,
    task6EvidenceSha256: evidence.sha256,
  });
  if (!options.apply) {
    process.stdout.write(`${heroVoiceCanaryJcsBytes(result).toString("utf8")}\n`);
    return;
  }
  const runState = await runHeroVoiceCanaryApply({
    runId: required("HERO_VOICE_CANARY_RUN_ID"),
    ownerHmac: computeHeroVoiceCanaryOwnerHmac({
      authIssuer: required("HERO_VOICE_CANARY_AUTH_ISSUER"),
      authSubject: required("HERO_VOICE_CANARY_AUTH_SUBJECT"),
      authAudience: required("HERO_VOICE_CANARY_AUTH_AUDIENCE"),
    }),
    referenceVoiceId: required("HERO_VOICE_CANARY_REFERENCE_VOICE_ID"),
    referenceWav: reference.wavBytes,
    manifest: built.manifest,
    manifestSha256: built.manifestSha256,
    task6EvidenceBytes: evidence.bytes!,
    task6EvidenceSha256: evidence.sha256!,
    adapterFactory: task7Adapter,
  });
  process.stdout.write(`${heroVoiceCanaryJcsBytes({ ...result, runState }).toString("utf8")}\n`);
}

main().catch((error) => {
  const code = error instanceof HeroVoiceCanaryLedgerError ? error.code : "CANARY_DRY_RUN_INVALID";
  process.stderr.write(`${JSON.stringify({ status: "blocked", code })}\n`);
  process.exitCode = 1;
});
