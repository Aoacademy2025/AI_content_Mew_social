/**
 * Content Preflight recommendation distribution benchmark.
 *
 * On prod, `expert-clarity` was first-ranked for 79% of Treatment pins — a
 * recommendation monoculture. This measures whether the neutral-last-resort
 * ranking rule fixes that, by running the REAL analyzer prompt over 20
 * de-identified Thai fixtures and printing which treatment each one ranks
 * first.
 *
 * Safe default: `--dry-run` validates the fixture set and prints the gates
 * without touching the network. A real run is PAID (about 20 Gemini text
 * calls) and stays locked behind CONTENT_PREFLIGHT_BENCHMARK_KEY, which is
 * only ever set after Mew's explicit go is recorded in the plan Status.
 *
 *   npm run benchmark:content-preflight-distribution -- --dry-run
 *   CONTENT_PREFLIGHT_BENCHMARK_KEY=... npm run benchmark:content-preflight-distribution
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: process.env.CONTENT_PREFLIGHT_BENCHMARK_ENV || ".env", quiet: true });

const FIXTURE_PATH = resolve("scripts/fixtures/content-preflight-distribution.json");
const OUTPUT_ROOT = resolve(
  process.env.CONTENT_PREFLIGHT_DISTRIBUTION_OUTPUT || "artifacts/content-preflight-distribution",
);
/** Enough windows for a realistic beat plan without paying for a long one. */
const WINDOWS_PER_FIXTURE = 4;
/** Gate 1: the neutral explainer may not own more than this share of the set. */
const MAX_EXPERT_CLARITY_SHARE = 0.4;
/** Gate 2: these categories carry an unmistakable frame across the whole script. */
const MUST_MATCH_CATEGORIES = ["ghost", "history", "news"] as const;
const EXPECTED_CATEGORY_COUNTS: Record<string, number> = {
  ghost: 3,
  history: 3,
  drama: 3,
  news: 3,
  finance: 3,
  health: 2,
  product: 3,
};

type Fixture = {
  id: string;
  category: string;
  expectedTreatmentPresetId: string;
  expectedStylePackId: string;
  script: string;
};

type FixtureFile = { version: number; entries: Fixture[] };

type Outcome = {
  id: string;
  category: string;
  expectedTreatmentPresetId: string;
  expectedStylePackId: string;
  firstRankedTreatmentPresetId?: string;
  rankedTreatmentPresetIds?: string[];
  suggestedVisualFormatId?: string;
  suggestedStylePackId?: string | null;
  treatmentMatched?: boolean;
  error?: string;
};

const dryRun = process.argv.includes("--dry-run");

function loadFixtures(): Fixture[] {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureFile;
  const entries = parsed.entries;
  if (!Array.isArray(entries) || entries.length !== 20) {
    throw new Error(`Expected 20 fixtures, received ${Array.isArray(entries) ? entries.length : "none"}`);
  }
  const ids = new Set<string>();
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    for (const field of ["id", "category", "expectedTreatmentPresetId", "expectedStylePackId", "script"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Fixture ${entry.id ?? "?"} is missing ${field}`);
      }
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate fixture id ${entry.id}`);
    ids.add(entry.id);
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  }
  for (const [category, expected] of Object.entries(EXPECTED_CATEGORY_COUNTS)) {
    if ((counts[category] ?? 0) !== expected) {
      throw new Error(`Category ${category} must hold ${expected} fixtures, found ${counts[category] ?? 0}`);
    }
  }
  const unknown = Object.keys(counts).filter((category) => !(category in EXPECTED_CATEGORY_COUNTS));
  if (unknown.length) throw new Error(`Unknown fixture categories: ${unknown.join(", ")}`);
  return entries;
}

async function validateFixturesAgainstCatalog(fixtures: Fixture[]): Promise<void> {
  const { TREATMENT_PRESET_IDS } = await import("../src/lib/brand-treatment-catalog");
  const { activeStylePacks } = await import("../src/lib/style-pack-catalog");
  const active = new Map(activeStylePacks().map((pack) => [pack.id, pack]));
  for (const fixture of fixtures) {
    if (!(TREATMENT_PRESET_IDS as readonly string[]).includes(fixture.expectedTreatmentPresetId)) {
      throw new Error(`Fixture ${fixture.id} expects unknown treatment ${fixture.expectedTreatmentPresetId}`);
    }
    const pack = active.get(fixture.expectedStylePackId as never);
    if (!pack) throw new Error(`Fixture ${fixture.id} expects a Style Pack that is not ACTIVE`);
    if (pack.treatmentPresetId !== fixture.expectedTreatmentPresetId) {
      throw new Error(`Fixture ${fixture.id} pairs ${fixture.expectedStylePackId} with the wrong treatment`);
    }
  }
}

function printGates(fixtures: Fixture[]): void {
  const mustMatch = fixtures.filter((fixture) =>
    (MUST_MATCH_CATEGORIES as readonly string[]).includes(fixture.category));
  console.log("Gates:");
  console.log(`  1. expert-clarity first-ranked <= ${Math.round(MAX_EXPERT_CLARITY_SHARE * 100)}% (max ${Math.floor(fixtures.length * MAX_EXPERT_CLARITY_SHARE)} of ${fixtures.length} fixtures)`);
  console.log(`  2. every ghost/history/news fixture ranks its matching preset first (${mustMatch.length} fixtures)`);
}

function report(outcomes: Outcome[]): boolean {
  const analyzed = outcomes.filter((outcome) => outcome.firstRankedTreatmentPresetId);
  const failedCalls = outcomes.filter((outcome) => outcome.error);
  const distribution = new Map<string, number>();
  for (const outcome of analyzed) {
    const key = outcome.firstRankedTreatmentPresetId!;
    distribution.set(key, (distribution.get(key) ?? 0) + 1);
  }
  console.log("\nFirst-ranked treatment distribution:");
  [...distribution.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([treatment, count]) => {
      const share = ((count / outcomes.length) * 100).toFixed(0);
      console.log(`  ${treatment.padEnd(34)} ${String(count).padStart(2)}  ${share}%`);
    });

  const expertClarity = distribution.get("expert-clarity") ?? 0;
  const expertClarityShare = expertClarity / outcomes.length;
  const gate1 = expertClarityShare <= MAX_EXPERT_CLARITY_SHARE;
  const mustMatch = outcomes.filter((outcome) =>
    (MUST_MATCH_CATEGORIES as readonly string[]).includes(outcome.category));
  const mismatched = mustMatch.filter((outcome) => !outcome.treatmentMatched);
  const gate2 = mismatched.length === 0;

  console.log("\nGate 1 expert-clarity first-ranked "
    + `${(expertClarityShare * 100).toFixed(0)}% (<= ${Math.round(MAX_EXPERT_CLARITY_SHARE * 100)}%): ${gate1 ? "PASS" : "FAIL"}`);
  console.log(`Gate 2 ghost/history/news matching preset first: ${gate2 ? "PASS" : "FAIL"}`);
  mismatched.forEach((outcome) => {
    console.log(`  ${outcome.id}: expected ${outcome.expectedTreatmentPresetId}, got ${outcome.firstRankedTreatmentPresetId ?? outcome.error}`);
  });
  if (failedCalls.length) {
    console.log(`\n${failedCalls.length} fixture(s) failed to analyze:`);
    failedCalls.forEach((outcome) => console.log(`  ${outcome.id}: ${outcome.error}`));
  }
  const packMatches = analyzed.filter((outcome) => outcome.suggestedStylePackId === outcome.expectedStylePackId).length;
  console.log(`\nSuggested Style Pack matched the expected pack for ${packMatches}/${outcomes.length} fixtures.`);
  const passed = gate1 && gate2 && failedCalls.length === 0;
  console.log(`\nRESULT: ${passed ? "PASS" : "FAIL"}`);
  return passed;
}

async function runPaid(fixtures: Fixture[], benchmarkKey: string): Promise<void> {
  // Only the benchmark key may pay for this run. Managed mode is resolved
  // before BYOK inside resolveGeminiKey, so a managed server key left in .env
  // would silently bill the team's account instead.
  process.env.MANAGED_GEMINI = "0";
  delete process.env.GEMINI_SERVER_KEY;

  const directory = mkdtempSync(join(tmpdir(), "content-preflight-distribution-"));
  process.env.DATABASE_URL = `file:${join(directory, "benchmark.db")}`;
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], { stdio: "ignore", env: process.env });

  const outcomes: Outcome[] = [];
  try {
    const { prisma } = await import("../src/lib/prisma");
    const { createGeminiContentPreflightAnalyzer, planNarrativeVisualWindows } =
      await import("../src/lib/content-preflight.server");
    const { stylePackForRecommendation } = await import("../src/lib/style-pack-catalog");
    const { encryptKey } = await import("../src/lib/key-crypto");

    const user = await prisma.user.create({
      data: {
        name: "Preflight distribution benchmark",
        email: "content-preflight-distribution@example.test",
        plan: "PRO",
        geminiKey: encryptKey(benchmarkKey),
      },
    });
    const analyzer = createGeminiContentPreflightAnalyzer(user.id);

    for (const fixture of fixtures) {
      const outcome: Outcome = {
        id: fixture.id,
        category: fixture.category,
        expectedTreatmentPresetId: fixture.expectedTreatmentPresetId,
        expectedStylePackId: fixture.expectedStylePackId,
      };
      try {
        const analysis = await analyzer.analyze({
          kind: "creator-script",
          text: fixture.script,
          windows: planNarrativeVisualWindows(fixture.script, WINDOWS_PER_FIXTURE),
        });
        const first = analysis.rankedTreatmentPresetIds[0];
        outcome.rankedTreatmentPresetIds = [...analysis.rankedTreatmentPresetIds];
        outcome.firstRankedTreatmentPresetId = first;
        outcome.suggestedVisualFormatId = analysis.suggestedVisualFormatId;
        outcome.suggestedStylePackId = stylePackForRecommendation({
          treatmentPresetId: first,
          visualFormatId: analysis.suggestedVisualFormatId,
        })?.id ?? null;
        outcome.treatmentMatched = first === fixture.expectedTreatmentPresetId;
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : "unknown analyzer failure";
      }
      console.log(`${fixture.id.padEnd(12)} ${outcome.firstRankedTreatmentPresetId ?? `ERROR ${outcome.error}`}`);
      outcomes.push(outcome);
    }
    await prisma.$disconnect();
  } finally {
    // The benchmark key was written into this throwaway database.
    rmSync(directory, { recursive: true, force: true });
  }

  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const resultPath = join(OUTPUT_ROOT, "results.json");
  const temporary = `${resultPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    benchmark: "content-preflight-distribution",
    generatedAt: new Date().toISOString(),
    windowsPerFixture: WINDOWS_PER_FIXTURE,
    outcomes,
  }, null, 2)}\n`);
  renameSync(temporary, resultPath);
  console.log(`\nResults written to ${resultPath}`);

  if (!report(outcomes)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  await validateFixturesAgainstCatalog(fixtures);

  if (dryRun) {
    console.log(JSON.stringify({
      mode: "dry-run",
      benchmark: "content-preflight-distribution",
      fixturePath: FIXTURE_PATH,
      fixtures: fixtures.length,
      categories: EXPECTED_CATEGORY_COUNTS,
      windowsPerFixture: WINDOWS_PER_FIXTURE,
      paidCallsStarted: false,
    }, null, 2));
    printGates(fixtures);
    console.log("\nDry run only — no provider call was made.");
    return;
  }

  const benchmarkKey = process.env.CONTENT_PREFLIGHT_BENCHMARK_KEY?.trim();
  if (!benchmarkKey) {
    console.error("รันจริงยังถูกล็อกไว้: ต้องได้ go จาก Mew ก่อน แล้วค่อยตั้ง CONTENT_PREFLIGHT_BENCHMARK_KEY / Paid run is locked: it needs Mew's explicit go recorded in the plan Status before CONTENT_PREFLIGHT_BENCHMARK_KEY is set — use --dry-run meanwhile.");
    process.exit(1);
  }
  await runPaid(fixtures, benchmarkKey);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "benchmark failed");
  process.exit(1);
});
