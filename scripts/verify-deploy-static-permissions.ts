import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deployScript = readFileSync("deploy/deploy.sh", "utf8");
const normalizeCommand = 'chmod -R a+rX "$STAGING_DIR"';
const commandCount = deployScript.split(normalizeCommand).length - 1;

assert.equal(
  commandCount,
  1,
  "deploy must normalize staging permissions exactly once",
);

const finalBuildGate = deployScript.lastIndexOf(
  'if [ ! -f "$STAGING_DIR/BUILD_ID" ]; then',
);
const normalizeAt = deployScript.indexOf(normalizeCommand);
const swapAt = deployScript.indexOf('mv "$STAGING_DIR" "$APP_DIR/.next"');

assert.ok(finalBuildGate >= 0, "final BUILD_ID gate is missing");
assert.ok(swapAt >= 0, "atomic staging swap is missing");
assert.ok(
  normalizeAt > finalBuildGate,
  "staging permissions must be normalized after the final BUILD_ID gate",
);
assert.ok(
  normalizeAt < swapAt,
  "staging permissions must be normalized before the atomic swap",
);

const root = mkdtempSync(join(tmpdir(), "heroai-next-permissions-"));
const staticDir = join(root, "static", "css");
const cssFile = join(staticDir, "app.css");

try {
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(cssFile, "body{}\n");
  chmodSync(root, 0o700);
  chmodSync(join(root, "static"), 0o700);
  chmodSync(staticDir, 0o700);
  chmodSync(cssFile, 0o600);

  const chmod = spawnSync("chmod", ["-R", "a+rX", root], {
    encoding: "utf8",
  });
  assert.equal(chmod.status, 0, chmod.stderr || "chmod failed");

  for (const dir of [root, join(root, "static"), staticDir]) {
    const mode = statSync(dir).mode & 0o777;
    assert.equal(
      mode & 0o005,
      0o005,
      `${dir} must be readable and traversable by the Nginx user`,
    );
  }

  const fileMode = statSync(cssFile).mode & 0o777;
  assert.equal(fileMode & 0o004, 0o004, "static files must be world-readable");
  assert.equal(
    fileMode & 0o111,
    0,
    "non-executable static files must remain non-executable",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("PASS deploy normalizes staged Next.js permissions before swap");
