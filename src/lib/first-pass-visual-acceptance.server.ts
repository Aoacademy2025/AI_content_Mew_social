import { createHash } from "node:crypto";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { parseProjectVisualContext } from "@/lib/project-visual-context";
import {
  recordTelemetryEvent,
  recordTelemetryEventOnce,
  type TelemetryInput,
} from "@/lib/telemetry";

type MeasurableActor = { role?: string | null; email?: string | null };

export type FirstPassVisualRejectionReason =
  | "scene_reroll"
  | "stock_replacement"
  | "upload_replacement"
  | "broll_disabled";

function measurablePin(
  actor: MeasurableActor,
  projectVisualContextJson: string | null | undefined,
) {
  if (actor.role === "ADMIN" || isInternalAiTester(actor)) return null;
  return parseProjectVisualContext(projectVisualContextJson)?.treatmentPin ?? null;
}

export function firstPassVisualRejectionEvent(input: {
  actor: MeasurableActor;
  projectId: string;
  videoJobId: string;
  sceneIndex: number;
  reason: FirstPassVisualRejectionReason;
  projectVisualContextJson: string | null | undefined;
}): TelemetryInput | null {
  const pin = measurablePin(input.actor, input.projectVisualContextJson);
  if (!pin) return null;
  return {
    name: "first_pass_visual_rejected",
    category: "product",
    source: "server",
    step: "post.broll",
    status: input.reason,
    value: 1,
    properties: {
      projectId: input.projectId,
      videoJobId: input.videoJobId,
      sceneIndex: input.sceneIndex,
      treatmentPresetId: pin.presetId,
      treatmentPresetVersion: pin.version,
    },
  };
}

export function firstPassVisualExportEvent(input: {
  actor: MeasurableActor;
  projectId: string;
  videoJobId: string;
  projectVisualContextJson: string | null | undefined;
  initialAiWindowCount: number;
}): TelemetryInput | null {
  const pin = measurablePin(input.actor, input.projectVisualContextJson);
  if (!pin || input.initialAiWindowCount <= 0) return null;
  return {
    name: "first_pass_visual_exported",
    category: "product",
    source: "server",
    step: "export",
    status: "completed",
    value: input.initialAiWindowCount,
    properties: {
      projectId: input.projectId,
      videoJobId: input.videoJobId,
      initialAiWindowCount: input.initialAiWindowCount,
      treatmentPresetId: pin.presetId,
      treatmentPresetVersion: pin.version,
    },
  };
}

export async function recordFirstPassVisualRejection(
  userId: string,
  input: Parameters<typeof firstPassVisualRejectionEvent>[0],
): Promise<void> {
  const event = firstPassVisualRejectionEvent(input);
  if (event) await recordTelemetryEvent(userId, event);
}

export async function recordFirstPassVisualExport(
  userId: string,
  input: Parameters<typeof firstPassVisualExportEvent>[0],
): Promise<void> {
  const event = firstPassVisualExportEvent(input);
  if (!event) return;
  await recordTelemetryEventOnce(
    userId,
    firstPassVisualExportDedupeKey(userId, input.projectId),
    event,
  );
}

export function firstPassVisualExportDedupeKey(userId: string, projectId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ userId, projectId }))
    .digest("hex");
  return `first-pass-visual-export:${digest}`;
}
