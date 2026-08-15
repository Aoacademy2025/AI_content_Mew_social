import {
  createGeminiContentPreflightAnalyzer,
  resolveContentPreflight,
  type ContentPreflightAnalyzer,
  type NarrativeVisualWindow,
  type ResolvedContentPreflight,
} from "@/lib/content-preflight.server";
import { resolveBrandVisualAccessByUserId } from "@/lib/brand-visual-rollout.server";

type UploadPreflightActor = {
  id: string;
  email?: string | null;
  role?: string | null;
  createdAt: Date;
};

type UploadPreflightDependencies = {
  resolve: typeof resolveContentPreflight;
  createAnalyzer: (userId: string) => ContentPreflightAnalyzer;
};

export type UploadContentPreflightResult =
  | { kind: "skipped"; reason: "no-project" | "not-in-treatment" }
  | { kind: "resolved"; preflight: ResolvedContentPreflight };

/**
 * Worker-side seam for uploaded clips. The browser cannot preflight an upload
 * until speech-to-text exists, so the durable worker resolves it immediately
 * after transcription and before any image request. Rollout stays server-owned:
 * control accounts never enter the new analysis path.
 */
export async function ensureUploadContentPreflight(
  input: {
    actor: UploadPreflightActor;
    projectId?: string | null;
    transcriptText: string;
    windows?: NarrativeVisualWindow[];
    sceneContentPolicy?: unknown;
    /** Acceptance-time treatment decision persisted on the VideoJob. When set,
     * rollout changes while the job waits cannot add or remove Brand Visual. */
    brandVisualAccepted?: boolean;
  },
  dependencies: UploadPreflightDependencies = {
    resolve: resolveContentPreflight,
    createAnalyzer: createGeminiContentPreflightAnalyzer,
  },
): Promise<UploadContentPreflightResult> {
  if (!input.projectId) return { kind: "skipped", reason: "no-project" };
  const canUse = input.brandVisualAccepted ?? (await resolveBrandVisualAccessByUserId(input.actor)).canUse;
  if (!canUse) {
    return { kind: "skipped", reason: "not-in-treatment" };
  }

  const preflight = await dependencies.resolve({
    userId: input.actor.id,
    projectId: input.projectId,
    narrativeSource: {
      kind: "upload-transcript",
      text: input.transcriptText,
      ...(input.windows ? { windows: input.windows } : {}),
      sceneContentPolicy: input.sceneContentPolicy,
    },
    analyzer: dependencies.createAnalyzer(input.actor.id),
  });
  return { kind: "resolved", preflight };
}
