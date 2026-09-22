// Run with: npx tsx scripts/verify-editor-script-loop-sensitivity.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const injected of [
  { mode: "production", message: /Minified React error #185/ },
  { mode: "development", message: /Maximum update depth exceeded/ },
] as const) {
  const probe = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/verify-editor-script-loop.tsx"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HERO_EDITOR_LOOP_INJECT_REACT_DEPTH_ERROR: injected.mode,
      },
    },
  );
  const output = `${probe.stdout}\n${probe.stderr}`;

  assert.notEqual(
    probe.status,
    0,
    `the diagnostic must fail when the ${injected.mode} maximum-depth error is injected\n${output}`,
  );
  assert.match(output, injected.message);
  console.log(`ok: diagnostic rejects the ${injected.mode} React maximum-depth error`);
}
