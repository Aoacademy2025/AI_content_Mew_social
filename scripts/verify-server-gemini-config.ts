// verify-server-gemini-config.ts — managed key via /admin (no SSH, no secret-in-chat)
//
// The /admin "Server Gemini Key" field saves SiteConfig `server_gemini_key`. The
// loanword cron already reads it (getServerGeminiKey, async). The MANAGED resolver
// (resolveGeminiKey) is SYNC and reads process.env.GEMINI_SERVER_KEY. This hydrates
// the DB value into that env var at boot so ONE admin field powers both — without
// touching the sync resolver or any route.
//
// Run: npx tsx scripts/verify-server-gemini-config.ts
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "srvgemini-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

let passed = 0, failures = 0;
function ok(c: boolean, m: string) {
  if (!c) { failures++; console.error("FAIL:", m); } else { passed++; console.log("ok:", m); }
}

async function main() {
  const { hydrateServerGeminiKeyEnv } = await import("../src/lib/server-keys");
  const { prisma } = await import("../src/lib/prisma");

  // ── DB row present, env empty → hydrate into GEMINI_SERVER_KEY ──
  delete process.env.GEMINI_SERVER_KEY;
  delete process.env.LOANWORD_MINER_GEMINI_KEY;
  await prisma.siteConfig.create({ data: { key: "server_gemini_key", value: "  sk-from-admin  " } });
  const changed = await hydrateServerGeminiKeyEnv();
  ok(changed === true, "returns true when it hydrated from DB");
  ok(process.env.GEMINI_SERVER_KEY === "sk-from-admin", "GEMINI_SERVER_KEY hydrated + trimmed (managed resolver path)");
  ok(process.env.LOANWORD_MINER_GEMINI_KEY === "sk-from-admin", "also fills LOANWORD_MINER_GEMINI_KEY (cron path) — one key powers both");

  // ── env already set → env WINS, no override (parity with ensureStripeConfig) ──
  process.env.GEMINI_SERVER_KEY = "sk-from-env";
  const changed2 = await hydrateServerGeminiKeyEnv();
  ok(changed2 === false && process.env.GEMINI_SERVER_KEY === "sk-from-env", "env set → not overridden by DB");

  // ── no DB row + no env → no-op, no crash ──
  delete process.env.GEMINI_SERVER_KEY;
  delete process.env.LOANWORD_MINER_GEMINI_KEY;
  await prisma.siteConfig.deleteMany({ where: { key: "server_gemini_key" } });
  const changed3 = await hydrateServerGeminiKeyEnv();
  ok(changed3 === false && !process.env.GEMINI_SERVER_KEY, "no row + no env → no-op (managed stays off, BYOK fallback)");

  console.log(`\n${failures === 0 ? "✅" : "❌"} ${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
