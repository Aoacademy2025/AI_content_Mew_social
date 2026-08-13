import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { readDirectorySizeMb } from "../src/lib/storage-health";

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
