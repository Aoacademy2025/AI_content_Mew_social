// Task B2 — one query for all SiteConfig keys (docs/plans/.../task-B2-brief.md).
//
// Two things this proves:
//  (a) getConfigs(keys) in src/lib/site-config.ts issues exactly ONE SELECT for
//      32 keys (5 seeded + 27 unknown), and unknown keys resolve to null.
//  (b) the admin/settings route's per-key env-var fallback behaviour is UNCHANGED
//      after it switches from Promise.all(KEYS.map(getConfig)) to one
//      getConfigs(KEYS) call — tested via the extracted pure resolver
//      `resolveSettingValue` exported from src/app/api/admin/settings/route.ts
//      (same pattern already used by scripts/verify-error-classify.ts importing
//      classifyJobError from admin/insights/route.ts).
//
// Self-contained: spins a throwaway SQLite DB, pushes the real schema.prisma.
// Query counting: installs a PrismaClient with query-event logging as the
// `globalThis.prisma` singleton BEFORE importing any app module — src/lib/prisma.ts
// reuses `globalForPrisma.prisma` when already set (its normal dev-hot-reload
// path), so getConfigs runs through our counting instance without any edit to
// src/lib/prisma.ts itself.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const dir = mkdtempSync(join(tmpdir(), "siteconfig-batch-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

async function main() {
  const countingClient = new PrismaClient({
    log: [{ level: "query", emit: "event" }],
  });
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = countingClient;

  let queryCount = 0;
  (countingClient as unknown as {
    $on: (ev: "query", cb: () => void) => void;
  }).$on("query", () => {
    queryCount++;
  });

  const { getConfigs } = await import("../src/lib/site-config");
  const { prisma } = await import("../src/lib/prisma");

  // ── (a) exactly one SELECT for 32 keys, unknown -> null ─────────────────
  const seeded = [
    "support_email",
    "plan_pro_price",
    "cost_render_per_minute",
    "fx_baht_per_usd",
    "server_gemini_key",
  ];
  for (const key of seeded) {
    await prisma.siteConfig.create({ data: { key, value: `val-${key}` } });
  }

  const unknown = Array.from({ length: 27 }, (_, i) => `unknown_key_${i}`);
  const keys = [...seeded, ...unknown];
  ok(keys.length === 32, "test harness assembled 32 keys (5 seeded + 27 unknown)");

  queryCount = 0;
  const result = await getConfigs(keys);

  ok(queryCount === 1, `getConfigs(32 keys) issued exactly 1 SELECT (got ${queryCount})`);
  for (const key of seeded) {
    ok(result[key] === `val-${key}`, `seeded key "${key}" returns its DB value`);
  }
  for (const key of unknown) {
    ok(result[key] === null, `unknown key "${key}" returns null`);
  }

  // ── (b) admin/settings route fallback resolver is unchanged ─────────────
  const { resolveSettingValue } = await import("../src/app/api/admin/settings/route");

  process.env.SUPPORT_EMAIL = "fallback@example.com";
  ok(
    resolveSettingValue("support_email", null) === "fallback@example.com",
    "resolveSettingValue: env fallback applies when DB row is missing"
  );
  ok(
    resolveSettingValue("support_email", "db@example.com") === "db@example.com",
    "resolveSettingValue: DB value wins over env fallback when present"
  );
  ok(
    resolveSettingValue("plan_free_price", null) === "",
    "resolveSettingValue: keys with no env fallback resolve to \"\" (unchanged default)"
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll site-config-batch checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
