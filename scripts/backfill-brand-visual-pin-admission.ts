// Backfill: EditorProject.brandVisualPinAdmittedCohort / brandVisualPinAdmittedAt
// (ADR 0059 amendment 2026-09-02, #430).
//
// Every pin written from now on records the owner's AI-image decision at pin
// time. Pins that already exist carry no such record, and the render path reads
// the stamp — so an established project would silently lose the grandfather
// clause it was legitimately using.
//
// Decision D3 (Mew, 2026-09-03): a legacy pin is stamped ONLY when the OWNER's
// CURRENT image decision is `canUse` — that account can generate managed images
// today anyway, so the stamp changes nothing about what it may do; it only
// keeps its established rerenders deterministic. Every other legacy pin stays
// unadmitted: we cannot prove it was ever admitted, and guessing would mint
// exactly the self-service admission this wave closes. Those projects keep
// their look and render with stock.
//
// --dry-run (default): prints the counts, writes nothing.
// --apply: stamps the eligible projects.
//
// Run (the react-server condition is required: this reads a server-only module):
//   node --conditions=react-server --import tsx \
//     scripts/backfill-brand-visual-pin-admission.ts [--apply]
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { resolveOwnerPinAdmission } from "../src/lib/brand-visual-pin-admission.server";

export type BackfillMode = "dry-run" | "apply";

export function modeFromArgs(args: string[]): BackfillMode {
  const known = new Set(["--apply", "--dry-run"]);
  if (args.some((arg) => !known.has(arg))) throw new Error("unknown backfill argument");
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("choose either --apply or --dry-run");
  }
  return args.includes("--apply") ? "apply" : "dry-run";
}

export type BackfillCounts = {
  /** Projects that own a pin and carry no admission yet. */
  scanned: number;
  /** …of those, the ones whose owner can use managed AI images today. */
  eligible: number;
  /** …of those, the ones this run actually stamped (0 for a dry run). */
  stamped: number;
  /** …of those, the ones deliberately left unadmitted (D3). */
  skipped: number;
  /** Owners seen, so a run can be sanity-checked against the cohort report. */
  owners: number;
};

const PAGE_SIZE = 500;

/**
 * One owner is resolved once and reused for all of that owner's legacy pins:
 * the decision is per-account, and re-deriving it per project would multiply
 * the entitlement query for no additional truth.
 *
 * The write is CAS-shaped (`updateMany` with `brandVisualPinAdmittedCohort:
 * null` still in the WHERE clause), so a pin written by a live request while
 * this backfill runs keeps ITS OWN admission instead of being overwritten by
 * this one.
 */
export async function backfillBrandVisualPinAdmission(
  mode: BackfillMode,
  now: Date = new Date(),
): Promise<BackfillCounts> {
  const counts: BackfillCounts = { scanned: 0, eligible: 0, stamped: 0, skipped: 0, owners: 0 };
  const admissionByOwner = new Map<string, Awaited<ReturnType<typeof resolveOwnerPinAdmission>>>();
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.editorProject.findMany({
      where: {
        brandVisualPinAdmittedCohort: null,
        OR: [
          { NOT: { projectLookJson: null } },
          { NOT: { brandProfileRevisionId: null } },
          { AND: [{ NOT: { treatmentPresetId: null } }, { NOT: { treatmentPresetVersion: null } }] },
        ],
      },
      select: { id: true, userId: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const project of page) {
      counts.scanned += 1;
      if (!admissionByOwner.has(project.userId)) {
        counts.owners += 1;
        admissionByOwner.set(project.userId, await resolveOwnerPinAdmission(project.userId, now));
      }
      const admission = admissionByOwner.get(project.userId) ?? null;
      if (!admission) {
        counts.skipped += 1;
        continue;
      }
      counts.eligible += 1;
      if (mode === "dry-run") continue;
      const updated = await prisma.editorProject.updateMany({
        where: { id: project.id, brandVisualPinAdmittedCohort: null },
        data: {
          brandVisualPinAdmittedCohort: admission.cohort,
          brandVisualPinAdmittedAt: admission.at,
        },
      });
      counts.stamped += updated.count;
    }
    if (page.length < PAGE_SIZE) break;
  }
  return counts;
}

async function main() {
  const mode = modeFromArgs(process.argv.slice(2));
  console.log(`[backfill-brand-visual-pin-admission] mode=${mode}`);
  const counts = await backfillBrandVisualPinAdmission(mode);
  console.log(`[backfill-brand-visual-pin-admission] unstamped pins scanned: ${counts.scanned}`);
  console.log(`[backfill-brand-visual-pin-admission] distinct owners: ${counts.owners}`);
  console.log(`[backfill-brand-visual-pin-admission] owner can use images today: ${counts.eligible}`);
  console.log(`[backfill-brand-visual-pin-admission] left unadmitted (D3): ${counts.skipped}`);
  console.log(`[backfill-brand-visual-pin-admission] stamped: ${counts.stamped}`);
  if (mode === "dry-run") {
    console.log("[backfill-brand-visual-pin-admission] dry run — nothing was written. Re-run with --apply.");
  }
  await prisma.$disconnect();
}

// Only run as a CLI; the verify script imports the functions above.
if (process.argv[1]?.endsWith("backfill-brand-visual-pin-admission.ts")) {
  main().catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
}
