import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { readDirectorySizeMb, getStorageHealth } from "../src/lib/storage-health";

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-health-verify-"));

  try {
    const disappearingEntryError = Object.assign(
      new Error("du: cannot access a cache entry: No such file or directory"),
      {
        code: 1,
        stdout: `2048\t${root}\n`,
        stderr: "du: cannot access a cache entry: No such file or directory\n",
      },
    );

    const sizeMb = await readDirectorySizeMb(root, async () => {
      throw disappearingEntryError;
    });

    assert.strictEqual(
      sizeMb,
      2,
      "a transient disappearing cache entry must not make storage health fail when du returned the directory total",
    );
    await assert.rejects(
      () =>
        readDirectorySizeMb(root, async () => {
          throw Object.assign(new Error("du: permission denied"), {
            code: 1,
            stdout: `2048\t${root}\n`,
            stderr: "du: cannot read directory: Permission denied\n",
          });
        }),
      /permission denied/i,
      "non-transient du failures must remain visible",
    );

    await assert.rejects(
      () =>
        readDirectorySizeMb(root, async () => {
          throw Object.assign(new Error("du: disappearing entry without total"), {
            code: 1,
            stdout: "",
            stderr: "du: cannot access a cache entry: No such file or directory\n",
          });
        }),
      /without total/i,
      "a disappearing-entry error without a usable total must remain visible",
    );

    console.log("verify-storage-health: 3/3 passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "storage-health-cache-verify-"));
  const cacheRootB = fs.mkdtempSync(path.join(os.tmpdir(), "storage-health-cache-verify-b-"));

  const seedDirs = (cwd: string) => {
    fs.mkdirSync(path.join(cwd, "public", "renders"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "stocks"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".tmp"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "public", "music"), { recursive: true });
  };
  seedDirs(cacheRoot);
  seedDirs(cacheRootB);

  try {
    let runDuCalls = 0;
    const stubRunDu = async (_file: string, args: string[]) => {
      runDuCalls += 1;
      const target = args[args.length - 1];
      return { stdout: `1024\t${target}\n` };
    };

    await getStorageHealth(cacheRoot, { now: 0, runDu: stubRunDu });
    await getStorageHealth(cacheRoot, { now: 0, runDu: stubRunDu });
    assert.strictEqual(
      runDuCalls,
      4,
      "a second call within the TTL, same cwd, must reuse the cached value (du runs once per directory)",
    );

    await getStorageHealth(cacheRoot, { now: 0, force: true, runDu: stubRunDu });
    assert.strictEqual(
      runDuCalls,
      8,
      "{ force: true } must bypass the cache and re-run du for every directory",
    );

    await getStorageHealth(cacheRoot, { now: 11 * 60 * 1000, runDu: stubRunDu });
    assert.strictEqual(
      runDuCalls,
      12,
      "a call past the 10-minute TTL must re-run du (cache entry expired)",
    );

    await getStorageHealth(cacheRootB, { now: 11 * 60 * 1000, runDu: stubRunDu });
    assert.strictEqual(
      runDuCalls,
      16,
      "a different cwd must get its own cache slot, not share the first cwd's cache",
    );

    console.log("verify-storage-health: cache 4/4 passed");
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(cacheRootB, { recursive: true, force: true });
  }

  // Source-level check: the storage page's mount effect must hit the cache
  // (no refresh=1); only the refresh button's onClick handler (refreshStorageInfo)
  // may bypass it. Guards against the mount call quietly regaining `?refresh=1`,
  // which would defeat the point of caching on every /admin/storage open.
  // (Task C3 moved this code from admin/page.tsx to admin/storage/page.tsx.)
  const adminPagePath = path.join(
    __dirname,
    "..",
    "src",
    "app",
    "(dashboard)",
    "admin",
    "storage",
    "page.tsx",
  );
  const adminPageSource = fs.readFileSync(adminPagePath, "utf8");

  assert.match(
    adminPageSource,
    /function loadStorageHealth\(force = false\)/,
    "loadStorageHealth must take a force parameter defaulting to false",
  );
  assert.match(
    adminPageSource,
    /fetch\(`\/api\/admin\/storage\$\{force \? "\?refresh=1" : ""\}`, \{ cache: "no-store" \}\)/,
    "loadStorageHealth must build the URL conditionally on force and always send cache: no-store",
  );
  assert.match(
    adminPageSource,
    /function refreshStorageInfo\(\) \{\s*\n\s*loadStorageHealth\(true\);/,
    "the refresh button's handler (refreshStorageInfo) must call loadStorageHealth(true) — bypass the cache",
  );
  assert.match(
    adminPageSource,
    /useEffect\(\(\) => \{[\s\S]*?\n\s*loadStorageHealth\(\);/,
    "the mount effect must call loadStorageHealth() with no argument — hit the cache",
  );

  console.log("verify-storage-health: mount-vs-refresh source check passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
