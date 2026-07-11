import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeMediaQuarantine } from "../src/lib/media-quarantine";

const DISABLED_ERROR = /permanent purge disabled pending shared writer exclusion/;

function operationErrorCount(error: unknown): number | undefined {
  return (error as { operationReport?: { errors?: { count?: number } } })
    .operationReport?.errors?.count;
}

async function expectDisabled(
  cwd: string,
  options: Record<string, unknown> = {},
): Promise<void> {
  let caught: unknown;
  try {
    await purgeMediaQuarantine({ cwd, ...options });
    assert.fail("permanent purge must be disabled");
  } catch (error) {
    caught = error;
  }
  assert.match(String(caught), DISABLED_ERROR);
  assert.equal(operationErrorCount(caught), 1, "disabled purge reports a nonzero error tally");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "media-purge-disabled-"));
  try {
    const quarantined = join(root, ".media-quarantine", "run", "renders", "candidate.mp4");
    mkdirSync(join(root, ".media-quarantine", "run", "renders"), { recursive: true });
    writeFileSync(quarantined, "only-copy");

    await expectDisabled(root);
    assert.equal(existsSync(quarantined), true, "ordinary purge performs zero deletes");

    writeFileSync(join(root, ".media-quarantine", "run", "manifest.json"), "{broken");
    await expectDisabled(root);
    assert.equal(existsSync(quarantined), true, "graph/manifest failure performs zero deletes");

    let filesystemSwapHookRan = false;
    await expectDisabled(root, {
      beforeUnlink: async () => {
        filesystemSwapHookRan = true;
        writeFileSync(quarantined, "swapped-after-graph");
      },
    });
    assert.equal(filesystemSwapHookRan, false, "disabled purge never reaches a post-graph hook");
    assert.equal(readFileSync(quarantined, "utf8"), "only-copy");

    let forgedBarrierRan = false;
    await expectDisabled(root, {
      writerBarrier: {
        runExclusive: async (operation: () => Promise<unknown>) => {
          forgedBarrierRan = true;
          return operation();
        },
      },
    });
    assert.equal(forgedBarrierRan, false, "an injected object cannot forge writer exclusion");
    assert.equal(existsSync(quarantined), true, "forged barrier-like options perform zero deletes");

    const repoRoot = process.cwd();
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
        join(repoRoot, "scripts", "media-cleanup.ts"),
        "--purge-quarantine",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: `file:${join(root, "test.db")}`,
          TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json"),
        },
      },
    );
    assert.notEqual(cli.status, 0, "CLI purge remains disabled");
    assert.match(cli.stderr, DISABLED_ERROR, "CLI reports the explicit writer-exclusion blocker");
    assert.equal(existsSync(quarantined), true, "CLI purge performs zero deletes");

    const source = readFileSync(join(repoRoot, "src/lib/media-quarantine.ts"), "utf8");
    const purgeStart = source.indexOf("export async function purgeMediaQuarantine");
    const purgeEnd = source.indexOf("export async function writeMediaHealthMetrics", purgeStart);
    assert.ok(purgeStart >= 0 && purgeEnd > purgeStart);
    assert.doesNotMatch(
      source.slice(purgeStart, purgeEnd),
      /\b(?:unlink|rm)\s*\(/,
      "disabled production purge contains no permanent deletion path",
    );

    console.log("media permanent-purge disabled verifier: PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
