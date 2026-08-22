import "server-only";

import { prisma } from "@/lib/prisma";
import { decideFirstClipPath, type FirstClipPathDecision } from "@/lib/first-clip-path";
import { isInternalNorthStarAccount } from "@/lib/subscription-north-star.server";
import { resolvePaidEquivalentEntitlement } from "@/lib/paid-equivalent-entitlement.server";
import { createBlankBrandProfileSeed } from "@/lib/brand-profile-seed";
import {
  brandProfilePayloadSchema,
  createBrandProfileFromPayload,
  pinProjectBrandRevision,
} from "@/lib/brand-profile-library.server";
import {
  resolveContentPreflight,
  type ContentPreflightAnalyzer,
  type NarrativeSourceKind,
} from "@/lib/content-preflight.server";

export async function userHasCompletedVideo(userId: string): Promise<boolean> {
  const completed = await prisma.video.findFirst({
    where: {
      userId,
      status: "COMPLETED",
      OR: [{ videoUrl: { not: null } }, { avatarVideoUrl: { not: null } }],
    },
    select: { id: true, videoUrl: true, avatarVideoUrl: true },
  });
  return Boolean(completed?.videoUrl?.trim() || completed?.avatarVideoUrl?.trim());
}

export async function resolveFirstClipPath(
  user: { id: string; email: string; role: string },
): Promise<FirstClipPathDecision> {
  const [paidEquivalent, hasCompletedVideo] = await Promise.all([
    resolvePaidEquivalentEntitlement(user.id),
    userHasCompletedVideo(user.id),
  ]);
  return decideFirstClipPath({
    isInternal: isInternalNorthStarAccount(user),
    paidEquivalent: paidEquivalent.canUsePaidFeatures,
    hasCompletedVideo,
  });
}

export async function ensureFirstClipBrandRevision(userId: string) {
  const existing = await prisma.brandProfile.findFirst({
    where: { userId, archivedAt: null, activeRevisionNumber: { gt: 0 } },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "asc" }],
  });
  if (existing) {
    const revision = await prisma.brandProfileRevision.findUnique({
      where: {
        brandProfileId_version: {
          brandProfileId: existing.id,
          version: existing.activeRevisionNumber,
        },
      },
    });
    if (revision) return { profile: existing, revision, created: false as const };
  }
  const seed = createBlankBrandProfileSeed();
  const payload = brandProfilePayloadSchema.parse({
    ...seed,
    name: "คลิปแรก",
    niche: "คลิปสั้น",
    audience: "",
  });
  const created = await createBrandProfileFromPayload({
    userId,
    payload,
    source: "manual",
  });
  return { profile: created.profile, revision: created.revision, created: true as const };
}

export async function ensureFirstClipProjectSpine(input: {
  userId: string;
  projectId: string;
}) {
  const { profile, revision } = await ensureFirstClipBrandRevision(input.userId);
  await pinProjectBrandRevision({
    userId: input.userId,
    projectId: input.projectId,
    profileId: profile.id,
    revisionId: revision.id,
  });
  return { profileId: profile.id, revisionId: revision.id };
}

/** Runs Content Preflight from the first-clip Narrative Source. Callers inject
 * the analyzer in tests; production uses the Gemini adapter via the worker. */
export async function ensureFirstClipContentPreflight(input: {
  userId: string;
  projectId: string;
  script: string;
  narrativeSourceKind?: NarrativeSourceKind;
  windowCount?: number;
  sceneContentPolicy?: unknown;
  analyzer?: ContentPreflightAnalyzer;
}) {
  const text = input.script.trim();
  if (!text) return { preflightId: null as string | null, skipped: true as const };
  const preflight = await resolveContentPreflight({
    userId: input.userId,
    projectId: input.projectId,
    narrativeSource: {
      kind: input.narrativeSourceKind ?? "creator-script",
      text,
      ...(input.windowCount ? { windowCount: input.windowCount } : {}),
      sceneContentPolicy: input.sceneContentPolicy,
    },
    analyzer: input.analyzer,
  });
  return { preflightId: preflight.id, skipped: false as const };
}
