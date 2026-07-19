import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { storageDaysForPlan, videoExpiryFor } from "@/lib/plan-limits";

const TEMPORARY_DATABASE_ERROR =
  "verification requires an explicit temporary SQLite DATABASE_URL under /tmp";
const PUBLIC_TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function pathIsMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function canonicalizeWithExistingAncestors(
  inputPath: string,
  visited = new Set<string>(),
): string {
  const absolutePath = resolve(inputPath);
  if (visited.has(absolutePath)) throw new Error("symlink cycle");
  visited.add(absolutePath);

  let cursor = absolutePath;
  const missingSuffix: string[] = [];

  while (true) {
    try {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink()) {
        try {
          return resolve(realpathSync.native(cursor), ...missingSuffix);
        } catch (error) {
          if (!pathIsMissing(error)) throw error;
          const linkTarget = resolve(dirname(cursor), readlinkSync(cursor));
          return resolve(canonicalizeWithExistingAncestors(linkTarget, visited), ...missingSuffix);
        }
      }
      return resolve(realpathSync.native(cursor), ...missingSuffix);
    } catch (error) {
      if (!pathIsMissing(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSuffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function assertTemporarySqliteDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "file:") throw new Error(TEMPORARY_DATABASE_ERROR);
    const databasePath = canonicalizeWithExistingAncestors(fileURLToPath(parsed));
    const temporaryRoot = realpathSync.native("/tmp");
    const relativePath = relative(temporaryRoot, databasePath);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error(TEMPORARY_DATABASE_ERROR);
    }
    return databasePath;
  } catch {
    throw new Error(TEMPORARY_DATABASE_ERROR);
  }
}

export type MediaExpiryBackfillTargetKind = "video" | "video-job";
export type MediaExpiryBackfillOwnerPlan = "FREE" | "PRO" | "BUSINESS";

type BaseCandidate = {
  targetId: string;
  ownerPlan: MediaExpiryBackfillOwnerPlan;
  createdAt: Date;
  trialStartedAt: Date | null;
};

export type MediaExpiryBackfillCandidate =
  | (BaseCandidate & {
      targetKind: "video";
    })
  | (BaseCandidate & {
      targetKind: "video-job";
      finishedAt: Date | null;
      updatedAt: Date | null;
    });

export type MediaExpiryBackfillRow = {
  targetKind: MediaExpiryBackfillTargetKind;
  targetId: string;
  ownerPlan: MediaExpiryBackfillOwnerPlan;
  baseAt: string;
  calculatedExpiresAt: string;
  alreadyExpired: boolean;
  reason: string;
};

export type MediaExpiryBackfillUpdateCounts = {
  total: number;
  videos: number;
  videoJobs: number;
};

export type MediaExpiryBackfillReport = {
  mode: "dry-run" | "apply";
  rows: MediaExpiryBackfillRow[];
  sha256: string;
  updated?: MediaExpiryBackfillUpdateCounts;
};

function compareRows(a: MediaExpiryBackfillRow, b: MediaExpiryBackfillRow): number {
  if (a.targetKind !== b.targetKind) return a.targetKind < b.targetKind ? -1 : 1;
  if (a.targetId === b.targetId) return 0;
  return a.targetId < b.targetId ? -1 : 1;
}

function iso(date: Date, field: string, targetId: string): string {
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid ${field} for media expiry backfill target ${targetId}`);
  }
  return date.toISOString();
}

function resolveCalculationPlan(
  candidate: MediaExpiryBackfillCandidate,
  baseAt: Date,
): { plan: MediaExpiryBackfillOwnerPlan; historicalTrialEvidence: boolean } {
  const trialStartedAt = candidate.trialStartedAt;
  if (!trialStartedAt) {
    return { plan: candidate.ownerPlan, historicalTrialEvidence: false };
  }

  const trialStartedAtMs = trialStartedAt.getTime();
  if (!Number.isFinite(trialStartedAtMs)) {
    throw new Error(`invalid trialStartedAt for media expiry backfill target ${candidate.targetId}`);
  }

  const baseAtMs = baseAt.getTime();
  const trialEndsAtMs = trialStartedAtMs + PUBLIC_TRIAL_DAYS * DAY_MS;
  const insideTrial = baseAtMs >= trialStartedAtMs && baseAtMs < trialEndsAtMs;
  const trialExtendsRetention =
    storageDaysForPlan(candidate.ownerPlan) < storageDaysForPlan("PRO");

  if (!insideTrial) {
    return { plan: candidate.ownerPlan, historicalTrialEvidence: false };
  }

  return {
    plan: trialExtendsRetention ? "PRO" : candidate.ownerPlan,
    historicalTrialEvidence: true,
  };
}

function historicalTrialReason(ownerPlan: MediaExpiryBackfillOwnerPlan): string {
  const retentionComparison =
    ownerPlan === "FREE"
      ? "historical PRO trial raises current FREE retention"
      : ownerPlan === "PRO"
        ? "current PRO retention matches the floor"
        : "current BUSINESS retention is longer";
  return `historical PRO trial retention floor is proven by trialStartedAt; ${retentionComparison}`;
}

export function planMediaExpiryBackfill(
  candidates: MediaExpiryBackfillCandidate[],
  now = new Date(),
): MediaExpiryBackfillRow[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("invalid media expiry backfill clock");

  return candidates
    .map((candidate): MediaExpiryBackfillRow => {
      if (candidate.targetKind === "video") {
        const baseAt = candidate.createdAt;
        const calculation = resolveCalculationPlan(candidate, baseAt);
        const calculatedExpiresAt = videoExpiryFor(calculation.plan, baseAt);
        return {
          targetKind: candidate.targetKind,
          targetId: candidate.targetId,
          ownerPlan: calculation.plan,
          baseAt: iso(baseAt, "createdAt", candidate.targetId),
          calculatedExpiresAt: iso(calculatedExpiresAt, "calculatedExpiresAt", candidate.targetId),
          alreadyExpired: calculatedExpiresAt.getTime() < nowMs,
          reason: calculation.historicalTrialEvidence
            ? `legacy Video expiresAt is null; ${historicalTrialReason(candidate.ownerPlan)}; base=createdAt`
            : "legacy Video expiresAt is null; current owner plan is the fallback because historical plan-at-creation is unavailable; base=createdAt",
        };
      }

      const baseField = candidate.finishedAt
        ? "finishedAt"
        : candidate.updatedAt
          ? "updatedAt"
          : "createdAt";
      const baseAt = candidate.finishedAt ?? candidate.updatedAt ?? candidate.createdAt;
      const calculation = resolveCalculationPlan(candidate, baseAt);
      const calculatedExpiresAt = videoExpiryFor(calculation.plan, baseAt);
      return {
        targetKind: candidate.targetKind,
        targetId: candidate.targetId,
        ownerPlan: calculation.plan,
        baseAt: iso(baseAt, baseField, candidate.targetId),
        calculatedExpiresAt: iso(calculatedExpiresAt, "calculatedExpiresAt", candidate.targetId),
        alreadyExpired: calculatedExpiresAt.getTime() < nowMs,
        reason: calculation.historicalTrialEvidence
          ? `legacy completed VideoJob mediaExpiresAt is null; ${historicalTrialReason(candidate.ownerPlan)}; base=${baseField}`
          : `legacy completed VideoJob mediaExpiresAt is null; current owner plan is the fallback because historical plan-at-completion is unavailable; base=${baseField}`,
      };
    })
    .sort(compareRows);
}

export function hashMediaExpiryBackfillRows(rows: MediaExpiryBackfillRow[]): string {
  const deterministicRows = [...rows].sort(compareRows);
  return createHash("sha256").update(JSON.stringify(deterministicRows), "utf8").digest("hex");
}

export async function discoverMediaExpiryBackfill(
  client: PrismaClient,
  now = new Date(),
): Promise<{ rows: MediaExpiryBackfillRow[]; sha256: string }> {
  const [videoJobs, videos] = await Promise.all([
    client.videoJob.findMany({
      where: { status: "done", mediaExpiresAt: null },
      orderBy: { id: "asc" },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        finishedAt: true,
        user: { select: { plan: true, trialStartedAt: true } },
      },
    }),
    client.video.findMany({
      where: { expiresAt: null },
      orderBy: { id: "asc" },
      select: {
        id: true,
        createdAt: true,
        user: { select: { plan: true, trialStartedAt: true } },
      },
    }),
  ]);

  const rows = planMediaExpiryBackfill(
    [
      ...videoJobs.map(
        (job): MediaExpiryBackfillCandidate => ({
          targetKind: "video-job",
          targetId: job.id,
          ownerPlan: job.user.plan,
          createdAt: job.createdAt,
          trialStartedAt: job.user.trialStartedAt,
          updatedAt: job.updatedAt,
          finishedAt: job.finishedAt,
        }),
      ),
      ...videos.map(
        (video): MediaExpiryBackfillCandidate => ({
          targetKind: "video",
          targetId: video.id,
          ownerPlan: video.user.plan,
          createdAt: video.createdAt,
          trialStartedAt: video.user.trialStartedAt,
        }),
      ),
    ],
    now,
  );

  return { rows, sha256: hashMediaExpiryBackfillRows(rows) };
}

export async function applyMediaExpiryBackfill(
  client: PrismaClient,
  rows: MediaExpiryBackfillRow[],
): Promise<MediaExpiryBackfillUpdateCounts> {
  const parsedRows = rows.map((row) => {
    const calculatedExpiresAt = new Date(row.calculatedExpiresAt);
    if (!Number.isFinite(calculatedExpiresAt.getTime())) {
      throw new Error(`invalid calculatedExpiresAt for media expiry backfill target ${row.targetId}`);
    }
    return { row, calculatedExpiresAt };
  });

  let videos = 0;
  let videoJobs = 0;

  for (const { row, calculatedExpiresAt } of parsedRows) {
    if (row.targetKind === "video-job") {
      const result = await client.videoJob.updateMany({
        where: { id: row.targetId, mediaExpiresAt: null },
        data: { mediaExpiresAt: calculatedExpiresAt },
      });
      videoJobs += result.count;
      continue;
    }

    const result = await client.video.updateMany({
      where: { id: row.targetId, expiresAt: null },
      data: { expiresAt: calculatedExpiresAt },
    });
    videos += result.count;
  }

  return { total: videos + videoJobs, videos, videoJobs };
}
