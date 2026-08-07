// Integration proof that the launch announcement is dry-run safe, repeatable,
// concurrency-safe, and republishes a pre-existing draft instead of silently
// claiming success. Always runs against a throwaway SQLite database.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hero-script-announcement-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  stdio: "ignore",
  env: process.env,
});

let passed = 0;
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`ok: ${message}`);
}

function publish(run: boolean) {
  execFileSync("npx", ["tsx", "scripts/publish-v1.5.1-hero-script.ts"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: { ...process.env, RUN: run ? "1" : "0" },
  });
}

function publishAsync() {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/publish-v1.5.1-hero-script.ts"], {
      cwd: process.cwd(),
      stdio: "ignore",
      env: { ...process.env, RUN: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`publisher exited ${code}`)));
  });
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");

  publish(false);
  check(await prisma.productUpdate.count() === 0, "default announcement run is read-only");

  await Promise.all([publishAsync(), publishAsync()]);
  const concurrentRows = await prisma.productUpdate.findMany({ where: { version: "v1.5.1" } });
  check(concurrentRows.length === 1, "two concurrent apply runs create exactly one announcement");
  check(concurrentRows[0]?.state === "PUBLISHED" && concurrentRows[0]?.targetPath === null,
    "created announcement is published system-wide");

  publish(true);
  check(await prisma.productUpdate.count({ where: { version: "v1.5.1" } }) === 1,
    "re-running after publish remains idempotent");

  await prisma.productUpdate.deleteMany({});
  const legacy = await prisma.productUpdate.create({
    data: {
      id: "legacy-v1-5-1-draft",
      version: "v1.5.1",
      title: "draft",
      summary: "draft",
      state: "DRAFT",
    },
  });
  publish(true);
  const republished = await prisma.productUpdate.findMany({ where: { version: "v1.5.1" } });
  check(republished.length === 1 && republished[0]?.id === legacy.id && republished[0]?.state === "PUBLISHED",
    "an existing draft is updated and published without creating a duplicate");

  await prisma.$disconnect();
  console.log(`\n✅ ${passed} announcement checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
