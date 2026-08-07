import { prisma } from "@/lib/prisma";

/**
 * Who is allowed to mint a paid Hero image reservation into the REFUNDABLE
 * `video:<videoJobId>:` idempotency namespace.
 *
 * Why this exists (P0-6): `refundSettledVideoImageBatch` compensates EVERY settled
 * image whose key starts with `video:<videoJobId>:` when that video fails. That is
 * correct only for images the render pipeline consumed on the user's behalf and never
 * delivered. A browser that could mint into the same namespace would get the images in
 * the HTTP response AND get the credits back by failing its own job afterwards — a free
 * image generator. So the namespace is restricted to requests that provably come from
 * the server-side render pipeline (the MCP service credential), on a VideoJob the caller
 * owns which is still running.
 *
 * Browser-originated Hero purchases are NOT blocked by this — they go through
 * `/api/videos/broll-window/generate`, which mints into the deliberately
 * non-refundable `broll-window:` namespace (an explicit, already-delivered purchase),
 * and AI Studio mints under `studio:`. Neither is swept.
 */

/** VideoJob.status values after which the pipeline can no longer consume new images. */
export const TERMINAL_VIDEO_JOB_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "canceled",
]);

export type HeroVideoMintDenialReason =
  /** Not from the render pipeline — a browser/API client asked for a refundable mint. */
  | "pipeline_only"
  /** No such VideoJob for this user (missing, or owned by somebody else). */
  | "video_not_found"
  /** The VideoJob already reached a terminal state; new images could never be delivered. */
  | "video_terminal";

export type HeroVideoMintDecision =
  | { ok: true }
  | { ok: false; reason: HeroVideoMintDenialReason };

/**
 * Pure policy. `videoJob` is the row looked up by id (NOT pre-filtered by owner) so the
 * ownership comparison is part of the tested policy rather than an implicit query detail.
 */
export function decideHeroVideoMint(input: {
  fromRenderPipeline: boolean;
  userId: string;
  videoJob: { userId: string; status: string } | null;
}): HeroVideoMintDecision {
  if (!input.fromRenderPipeline) return { ok: false, reason: "pipeline_only" };
  if (!input.videoJob || input.videoJob.userId !== input.userId) {
    return { ok: false, reason: "video_not_found" };
  }
  if (TERMINAL_VIDEO_JOB_STATUSES.has(input.videoJob.status)) {
    return { ok: false, reason: "video_terminal" };
  }
  return { ok: true };
}

/**
 * DB-backed authorization for one `video:<videoJobId>:` mint. Call this BEFORE any
 * credit reservation on a path that builds such a key. The provenance check runs first
 * so a forgeable caller never even triggers a lookup on an id it supplied.
 */
export async function authorizeHeroVideoMint(input: {
  fromRenderPipeline: boolean;
  userId: string;
  videoJobId: string;
}): Promise<HeroVideoMintDecision> {
  if (!input.fromRenderPipeline) return { ok: false, reason: "pipeline_only" };
  const videoJob = await prisma.videoJob.findUnique({
    where: { id: input.videoJobId },
    select: { userId: true, status: true },
  });
  return decideHeroVideoMint({
    fromRenderPipeline: input.fromRenderPipeline,
    userId: input.userId,
    videoJob,
  });
}

/** One literal per denial so every entry point answers with identical copy/status. */
export const HERO_VIDEO_MINT_DENIAL_RESPONSES: Record<
  HeroVideoMintDenialReason,
  { status: 403 | 404 | 409; body: { error: HeroVideoMintDenialReason; message: string } }
> = {
  pipeline_only: {
    status: 403,
    body: {
      error: "pipeline_only",
      message:
        "Hero AI Image สร้างได้จากขั้นตอนเรนเดอร์ของตัวตัดต่อเท่านั้น กรุณากดเรนเดอร์จากหน้าตัดต่อเพื่อเริ่มงาน",
    },
  },
  video_not_found: {
    status: 404,
    body: {
      error: "video_not_found",
      message: "ไม่พบงานวิดีโอสำหรับคำขอนี้",
    },
  },
  video_terminal: {
    status: 409,
    body: {
      error: "video_terminal",
      message: "งานวิดีโอนี้จบแล้ว จึงสร้างภาพเพิ่มให้ไม่ได้",
    },
  },
};
