import {
  createGeminiContentPreflightAnalyzer,
  resolveContentPreflight,
  type ContentPreflightAnalyzer,
  type NarrativeSourceKind,
  type NarrativeVisualWindow,
  type ResolvedContentPreflight,
} from "@/lib/content-preflight.server";
import { pinProjectVisualContextToVideoJob } from "@/lib/project-look.server";
import { resolveBrandVisualAccessByUserId } from "@/lib/brand-visual-rollout.server";

type VideoJobPreflightActor = {
  id: string;
  email?: string | null;
  role?: string | null;
  createdAt: Date;
};

type VideoJobPreflightDependencies = {
  resolve: typeof resolveContentPreflight;
  createAnalyzer: (userId: string) => ContentPreflightAnalyzer;
};

export type VideoJobContentPreflightResult =
  | { kind: "skipped"; reason: "no-project" | "not-accepted" }
  | { kind: "resolved"; preflight: ResolvedContentPreflight };

/** Durable worker seam for a Render accepted before visual planning finishes.
 * It performs the one Content Preflight and atomically replaces the pending
 * VideoJob snapshot with the completed project Treatment Pin before any image
 * provider or image-funding seam is reached. */
export async function ensureVideoJobContentPreflight(
  input: {
    actor: VideoJobPreflightActor;
    projectId?: string | null;
    videoJobId: string;
    narrativeSource: {
      kind: NarrativeSourceKind;
      text: string;
      windowCount?: number;
      windows?: NarrativeVisualWindow[];
      sceneContentPolicy?: unknown;
    };
    brandVisualAccepted?: boolean;
  },
  dependencies: VideoJobPreflightDependencies = {
    resolve: resolveContentPreflight,
    createAnalyzer: createGeminiContentPreflightAnalyzer,
  },
): Promise<VideoJobContentPreflightResult> {
  if (!input.projectId) return { kind: "skipped", reason: "no-project" };
  const accepted = input.brandVisualAccepted
    ?? (await resolveBrandVisualAccessByUserId(input.actor)).canUse;
  if (!accepted) return { kind: "skipped", reason: "not-accepted" };

  const preflight = await dependencies.resolve({
    userId: input.actor.id,
    projectId: input.projectId,
    narrativeSource: input.narrativeSource,
    analyzer: dependencies.createAnalyzer(input.actor.id),
  });
  await pinProjectVisualContextToVideoJob({
    userId: input.actor.id,
    projectId: input.projectId,
    videoJobId: input.videoJobId,
    preflightId: preflight.id,
  });
  return { kind: "resolved", preflight };
}
