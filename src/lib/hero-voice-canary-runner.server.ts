import {
  issueHeroVoiceCanarySubmitCapability,
  type SignedHeroVoiceCanarySubmitCapability,
} from "@/lib/hero-voice-canary-admission.server";
export { submitHeroVoiceCanaryCandidateViaLoopback } from "@/lib/hero-voice-canary-loopback-transport";
import {
  assertHeroVoiceCanaryTask6ApplyEvidence,
  createHeroVoiceCanaryRun,
  dispatchNextHeroVoiceCanarySlot,
  finalizeHeroVoiceCanaryRun,
  recordHeroVoiceCanaryObjectiveObservation,
  recordHeroVoiceCanaryCerBatch,
  recordHeroVoiceCanaryResult,
  reconcileHeroVoiceCanaryRun,
  type HeroVoiceCanaryAcceptedOutcome,
  type HeroVoiceCanaryCancelDisposition,
  type HeroVoiceCanaryCerBatchResult,
  type HeroVoiceCanaryEvaluatorEvidence,
} from "@/lib/hero-voice-canary-ledger.server";
import { captureHeroVoiceCanaryObjectiveEvidenceAuthority } from "@/lib/hero-voice-canary-objective-evidence.server";
import {
  HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
  type HeroVoiceCanaryManifest,
  type HeroVoiceCanarySlot,
} from "@/lib/hero-voice-canary-manifest";
import { prepareHeroVoiceCanaryWireRequest } from "@/lib/hero-voice-canary-wire";
import { awaitHeroVoiceCanaryApplicationTerminal } from "@/lib/hero-voice-generation.server";
import { readHeroVoiceCanaryDirectAudio, heroVoiceCanaryTerminalMetadata } from "@/lib/hero-voice-canary-direct-audio";
import { writeHeroVoiceCanaryRunOutput } from "@/lib/hero-voice-canary-run-outputs.server";

export type HeroVoiceCanaryAdapterResult = Readonly<{
  outcome: HeroVoiceCanaryAcceptedOutcome;
  primaryStatus: "completed" | "failed" | "cancelled" | "timed_out" | "unknown";
  cancelDisposition?: HeroVoiceCanaryCancelDisposition;
  audioSha256?: string;
  durationMs?: number;
  delayTimeMs?: number;
  executionTimeMs?: number;
}>;

/** Only the direct child-to-parent terminal reply may contain the WAV payload.
 * A valid-completed reply without exact delivered bytes is rejected by parent. */
export type HeroVoiceCanaryDirectAdapterResult = HeroVoiceCanaryAdapterResult & Readonly<{
  audioBase64?: string;
}>;

export type HeroVoiceCanaryBatch = Readonly<{
  evidence: HeroVoiceCanaryEvaluatorEvidence;
  results: readonly HeroVoiceCanaryCerBatchResult[];
  objectiveRows: unknown;
}>;

/** The real Task 7 adapter implements this boundary using the already-pinned
 * RunPod/AiStudio transports. Task 5's verifier supplies a deterministic fake;
 * the orchestration code is identical and never retries a submission. */
export interface HeroVoiceCanaryApplyAdapter {
  dispatchDirect(slot: HeroVoiceCanarySlot, exactJcsBytes: Buffer): Promise<
    | { disposition: "provider_accepted"; providerJobId: string }
    | { disposition: "provider_rejected" }
    | { disposition: "transport_unknown" }
  >;
  submitCandidate(slot: HeroVoiceCanarySlot, signed: SignedHeroVoiceCanarySubmitCapability): Promise<
    | { disposition: "application_accepted"; applicationJobId: string }
    | { disposition: "application_rejected" }
    | { disposition: "transport_unknown" }
  >;
  awaitDirectTerminal(slot: HeroVoiceCanarySlot, providerJobId: string): Promise<HeroVoiceCanaryDirectAdapterResult>;
  evaluateBatch(
    kind: "ablation-8" | "final-36",
    slots: readonly HeroVoiceCanarySlot[],
  ): Promise<HeroVoiceCanaryBatch>;
  dispose?(): Promise<void>;
}

export async function runHeroVoiceCanaryApply(input: {
  runId: string;
  ownerHmac: string;
  referenceVoiceId: string;
  referenceWav: Buffer;
  manifest: HeroVoiceCanaryManifest;
  manifestSha256: string;
  task6EvidenceBytes: Uint8Array;
  task6EvidenceSha256: string;
  adapter?: HeroVoiceCanaryApplyAdapter;
  adapterFactory?: () => Promise<HeroVoiceCanaryApplyAdapter>;
}): Promise<"reviewable" | "completed_no_go" | "aborted_no_go"> {
  // Authorization is checked before the first durable mutation. The evidence
  // is manifest-bound, authenticated, expiring, and enumerates every Task 6
  // gate, so this runner is executable without becoming an evidence bypass.
  assertHeroVoiceCanaryTask6ApplyEvidence({
    evidenceBytes: input.task6EvidenceBytes,
    expectedSha256: input.task6EvidenceSha256,
    manifestSha256: input.manifestSha256,
  });
  const objectiveAuthority = captureHeroVoiceCanaryObjectiveEvidenceAuthority();
  if (Boolean(input.adapter) === Boolean(input.adapterFactory)) throw new Error("canary_apply_adapter_invalid");
  const adapter = input.adapter ?? await input.adapterFactory!();
  try {
    await createHeroVoiceCanaryRun(input);
  let acceptedProviderJobId: string | null = null;
  const dispatchPhase = async (phase: HeroVoiceCanarySlot["phase"]): Promise<boolean> => {
    const slots = input.manifest.slots.filter((slot) => slot.phase === phase);
    for (const slot of slots) {
      let handle: Readonly<{ kind: "provider" | "application"; id: string }> | null = null;
      if (slot.runnerKind === "CandidateAiStudioV3") {
        // CandidateAiStudioV3 owns its intent in generation's mandatory
        // beforeDispatch callback. The runner owns only the one-use admission;
        // preclaiming here would create the exact double-intent bug this seam
        // is designed to make impossible.
        const signed = await issueHeroVoiceCanarySubmitCapability({
          runId: input.runId,
          ownerHmac: input.ownerHmac,
          slotId: slot.slotId,
        });
        const submitted = await adapter.submitCandidate(slot, signed);
        if (submitted.disposition !== "application_accepted") return false;
        const reconciled = await reconcileHeroVoiceCanaryRun({ runId: input.runId, ownerHmac: input.ownerHmac });
        if (!reconciled.resumableProviderJobId
          || reconciled.runState === "aborted_no_go" || reconciled.runState === "completed_no_go") return false;
        handle = Object.freeze({ kind: "application", id: submitted.applicationJobId });
      } else {
        acceptedProviderJobId = null;
        const prepared = prepareHeroVoiceCanaryWireRequest({
          slot, referenceWav: input.referenceWav, refText: HERO_VOICE_CANARY_REFERENCE_TRANSCRIPT,
        });
        await dispatchNextHeroVoiceCanarySlot({
          runId: input.runId,
          ownerHmac: input.ownerHmac,
          slotId: slot.slotId,
          prepared,
          dispatch: async (bytes) => {
            if (bytes !== prepared.bytes) throw new Error("canary_exact_buffer_identity_lost");
            const result = await adapter.dispatchDirect(slot, bytes);
            if (result.disposition === "provider_accepted") acceptedProviderJobId = result.providerJobId;
            return result;
          },
        });
        if (!acceptedProviderJobId) return false;
        handle = Object.freeze({ kind: "provider", id: acceptedProviderJobId });
      }
      const delivered = handle.kind === "application"
        ? await awaitHeroVoiceCanaryApplicationTerminal({
            runId: input.runId,
            ownerHmac: input.ownerHmac,
            slot,
            applicationJobId: handle.id,
          })
        : await adapter.awaitDirectTerminal(slot, handle.id);
      let terminal = heroVoiceCanaryTerminalMetadata(delivered);
      if (handle.kind === "provider" && delivered.outcome === "valid_completed") {
        let audio: Buffer | undefined;
        try {
          audio = readHeroVoiceCanaryDirectAudio(delivered);
        } catch {
          terminal = {
            outcome: "application_validation_failed", primaryStatus: "completed",
          };
        }
        if (audio) {
          // The durable, parent-owned creation intent precedes sensitive bytes;
          // a crash cannot leave a ledger-valid output outside deletion scope.
          const stored = await writeHeroVoiceCanaryRunOutput({
            runId: input.runId, ownerHmac: input.ownerHmac, slotId: slot.slotId,
            providerJobId: handle.id, audio,
          });
          terminal = { ...terminal, audioSha256: stored.audioSha256, durationMs: stored.durationMs };
        }
      }
      await recordHeroVoiceCanaryResult({
        runId: input.runId, ownerHmac: input.ownerHmac, slotId: slot.slotId, ...terminal,
      });
      if (terminal.outcome !== "valid_completed") return false;
      // Slot 27 is the first and only candidate smoke. Nothing after it can be
      // submitted until its terminal application validation has succeeded.
      if (slot.smoke && slot.ordinal !== 27) throw new Error("canary_smoke_identity_invalid");
    }
    return true;
  };

  if (!await dispatchPhase("ablation")) return "aborted_no_go";
  const ablationSlots = input.manifest.slots.filter((slot) => slot.phase === "ablation");
  const ablation = await adapter.evaluateBatch("ablation-8", ablationSlots);
  await recordHeroVoiceCanaryCerBatch({
    runId: input.runId, ownerHmac: input.ownerHmac, evidence: ablation.evidence, results: ablation.results,
  });
  const ablationObjective = await recordHeroVoiceCanaryObjectiveObservation({
    runId: input.runId,
    ownerHmac: input.ownerHmac,
    phase: "ablation-8",
    rows: ablation.objectiveRows,
    authority: objectiveAuthority,
  });
  const ablationState = await finalizeHeroVoiceCanaryRun({
    runId: input.runId, ownerHmac: input.ownerHmac, evidence: ablation.evidence,
    objectiveEvidenceBytes: ablationObjective.bytes,
    objectiveEvidenceSha256: ablationObjective.sha256,
    objectiveEvidenceHmac: ablationObjective.hmac,
    objectiveAuthority,
  });
  if (ablationState !== "running_baseline") return ablationState as "completed_no_go" | "aborted_no_go";

  if (!await dispatchPhase("baseline")) return "aborted_no_go";
  const baselineState = await finalizeHeroVoiceCanaryRun({
    runId: input.runId, ownerHmac: input.ownerHmac, evidence: ablation.evidence,
  });
  if (baselineState !== "running_candidate") return baselineState as "completed_no_go" | "aborted_no_go";

  if (!await dispatchPhase("candidate")) return "aborted_no_go";
  const finalSlots = input.manifest.slots.filter((slot) => slot.phase !== "ablation");
  const final = await adapter.evaluateBatch("final-36", finalSlots);
  await recordHeroVoiceCanaryCerBatch({
    runId: input.runId, ownerHmac: input.ownerHmac, evidence: final.evidence, results: final.results,
  });
  const finalObjective = await recordHeroVoiceCanaryObjectiveObservation({
    runId: input.runId,
    ownerHmac: input.ownerHmac,
    phase: "final-36",
    rows: final.objectiveRows,
    authority: objectiveAuthority,
  });
  const finalState = await finalizeHeroVoiceCanaryRun({
    runId: input.runId, ownerHmac: input.ownerHmac, evidence: final.evidence,
    objectiveEvidenceBytes: finalObjective.bytes,
    objectiveEvidenceSha256: finalObjective.sha256,
    objectiveEvidenceHmac: finalObjective.hmac,
    objectiveAuthority,
  });
    return finalState === "reviewable" ? "reviewable"
      : finalState === "aborted_no_go" ? "aborted_no_go" : "completed_no_go";
  } finally {
    await adapter.dispose?.();
  }
}

/** Restart entrypoint used before Task 7 resumes polling. A provider-accepted
 * ID is returned; unresolved intent is atomically terminalized unknown/no-go. */
export async function resumeHeroVoiceCanaryApply(input: { runId: string; ownerHmac: string }) {
  return reconcileHeroVoiceCanaryRun(input);
}
