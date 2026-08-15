import "dotenv/config";
import { brandVisualRolloutFlags, decideBrandVisualAccess } from "../src/lib/brand-visual-rollout.server";
import { VISUAL_FORMATS } from "../src/lib/brand-visual-system";
import { prisma } from "../src/lib/prisma";

/**
 * One-shot: move Brand Profile Revisions from the frozen `-v2` prompt recipe to
 * the story-first `-v3` recipe.
 *
 * ADR 0005 pins a recipe version per revision, so rewriting one changes what an
 * already-published Brand Look renders. That is only acceptable while the
 * Brand Visual System is internal-only, which is a question about the whole
 * population and not about one row: if a single revision belongs to a
 * non-internal account — at any recipe version, including one this migration
 * would not otherwise touch — the migration refuses to run and every existing
 * revision keeps rendering on its pinned recipe until its owner republishes.
 *
 * Dry run:  npx tsx scripts/migrate-brand-visual-recipe-v3.ts
 * Apply:    npx tsx scripts/migrate-brand-visual-recipe-v3.ts --apply
 */

type RevisionRow = {
  revisionId: string;
  brandProfileId: string;
  version: number;
  ownerEmail: string;
  ownerInternal: boolean;
  recipeVersion: string | null;
  nextRecipeVersion: string | null;
  action: "rewrite" | "skip-not-v2" | "blocked-external-owner" | "blocked-unreadable" | "blocked-unknown-target";
};

type MigrationReport = {
  mode: "dry-run" | "apply";
  totalRevisions: number;
  rewritable: number;
  blocked: number;
  /** Every revision owned by a non-internal account, at any recipe version.
   * Non-zero is a hard stop, not a filter. */
  externalRevisions: number;
  externalOwners: string[];
  rows: RevisionRow[];
  updated?: number;
};

function readArgs(argv: string[]): { apply: boolean } {
  const unknown = argv.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
  return { apply: argv.includes("--apply") };
}

/** Internal admission, evaluated with the kill switch neutralized: the question
 * here is "who owns this row", not "who may use the feature right now". */
function isInternalOwner(owner: { id: string; email: string; role: string; createdAt: Date }): boolean {
  return decideBrandVisualAccess(
    owner,
    { canUsePaidFeatures: false, source: "none" },
    { ...brandVisualRolloutFlags(), enabled: true },
  ).cohort === "internal";
}

function storedRecipeVersion(visualRecipeJson: string): string | null {
  try {
    const parsed = JSON.parse(visualRecipeJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).recipeVersion;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function nextRecipeVersion(current: string): string | null {
  if (!current.endsWith("-v2")) return null;
  const next = `${current.slice(0, -"-v2".length)}-v3`;
  return VISUAL_FORMATS.some((format) => format.recipeVersion === next) ? next : null;
}

function rewriteRecipeVersion(visualRecipeJson: string, next: string): string {
  const parsed = JSON.parse(visualRecipeJson) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, recipeVersion: next });
}

async function main() {
  const { apply } = readArgs(process.argv.slice(2));
  const revisions = await prisma.brandProfileRevision.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      brandProfileId: true,
      version: true,
      visualRecipeJson: true,
      brandProfile: {
        select: {
          user: { select: { id: true, email: true, role: true, createdAt: true } },
        },
      },
    },
  });

  const rows: RevisionRow[] = revisions.map((revision) => {
    const owner = revision.brandProfile.user;
    const ownerInternal = isInternalOwner(owner);
    const recipeVersion = storedRecipeVersion(revision.visualRecipeJson);
    const next = recipeVersion ? nextRecipeVersion(recipeVersion) : null;
    // Ownership is checked before the recipe version: the go/no-go signal is
    // "does production hold any external Brand Profile Revision", so an
    // external row pinned at -v1 or already at -v3 must block just as loudly
    // as one at -v2 and must surface its owner in the report.
    const action: RevisionRow["action"] = !ownerInternal
      ? "blocked-external-owner"
      : recipeVersion === null
        ? "blocked-unreadable"
        : !recipeVersion.endsWith("-v2")
          ? "skip-not-v2"
          : next === null
            ? "blocked-unknown-target"
            : "rewrite";
    return {
      revisionId: revision.id,
      brandProfileId: revision.brandProfileId,
      version: revision.version,
      ownerEmail: owner.email,
      ownerInternal,
      recipeVersion,
      nextRecipeVersion: action === "rewrite" ? next : null,
      action,
    };
  });

  const rewritable = rows.filter((row) => row.action === "rewrite");
  const blocked = rows.filter((row) => row.action.startsWith("blocked-"));
  const externalRows = rows.filter((row) => !row.ownerInternal);
  const externalOwners = [...new Set(externalRows.map((row) => row.ownerEmail))].sort();
  const report: MigrationReport = {
    mode: apply ? "apply" : "dry-run",
    totalRevisions: rows.length,
    rewritable: rewritable.length,
    blocked: blocked.length,
    externalRevisions: externalRows.length,
    externalOwners,
    rows,
  };

  if (!apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (blocked.length > 0) {
      process.stdout.write(
        "migrate-brand-visual-recipe-v3: --apply is refused while any revision is blocked\n",
      );
    }
    return;
  }

  if (blocked.length > 0) {
    throw new Error(
      `refusing to migrate: ${blocked.length} revision(s) are blocked (external owners: ${externalOwners.join(", ") || "none"})`,
    );
  }
  if (rewritable.length === 0) {
    process.stdout.write(`${JSON.stringify({ ...report, updated: 0 }, null, 2)}\n`);
    return;
  }

  let updated = 0;
  for (const row of rewritable) {
    // Re-read inside the write so a revision published between the plan and the
    // apply is never rewritten from a stale snapshot.
    const current = await prisma.brandProfileRevision.findUnique({
      where: { id: row.revisionId },
      select: { visualRecipeJson: true },
    });
    if (!current || storedRecipeVersion(current.visualRecipeJson) !== row.recipeVersion) {
      throw new Error(`revision ${row.revisionId} changed since the plan was built; re-run the dry run`);
    }
    await prisma.brandProfileRevision.update({
      where: { id: row.revisionId },
      data: { visualRecipeJson: rewriteRecipeVersion(current.visualRecipeJson, row.nextRecipeVersion!) },
    });
    updated += 1;
    process.stdout.write(
      `migrated revision ${row.revisionId} (brand ${row.brandProfileId} v${row.version}, owner ${row.ownerEmail}): ${row.recipeVersion} -> ${row.nextRecipeVersion}\n`,
    );
  }

  process.stdout.write(`${JSON.stringify({ ...report, updated }, null, 2)}\n`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "brand visual recipe migration failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
