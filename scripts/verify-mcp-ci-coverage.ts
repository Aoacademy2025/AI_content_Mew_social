// Guards against a new MCP (or media-import / safe-fetch) verify script silently rotting
// as an orphan — written, passing locally, never run by CI. Before this task,
// verify-mcp-parity.ts, verify-mcp-audit-status.ts, verify-mcp-orchestrator-steps.ts,
// verify-mcp-orchestrator.ts, verify-mcp-pipeline-timeout.ts, verify-mcp-token.ts and
// verify-mcp-videojob.ts all existed on disk with zero CI coverage.
//
// Every file matching scripts/verify-mcp-*.ts, scripts/verify-media-import*.ts or
// scripts/verify-safe-fetch.ts must be either:
//   (a) reachable from a `run:` line in .github/workflows/ci.yml — directly (a literal
//       `scripts/*.ts` path in the shell command) or transitively through an `npm run <x>`
//       chain resolved against package.json's `scripts` map, to any depth; or
//   (b) listed in scripts/mcp-verify-exclusions.json with a one-line reason.
//
// The exclusion file itself is also checked: every path it lists must exist on disk and
// must NOT be reachable from CI (an exclusion for a script CI already runs is a lie).
//
// Run: npx tsx scripts/verify-mcp-ci-coverage.ts

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(ROOT, ".github/workflows/ci.yml");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const SCRIPTS_DIR_NAME = "scripts";
const SCRIPTS_DIR = join(ROOT, SCRIPTS_DIR_NAME);
const EXCLUSIONS_PATH = join(SCRIPTS_DIR, "mcp-verify-exclusions.json");

const GLOB_PATTERNS: RegExp[] = [
  /^verify-mcp-.*\.ts$/,
  /^verify-media-import.*\.ts$/,
  /^verify-safe-fetch\.ts$/,
];

let failures = 0;
function ok(cond: boolean, msg: string) {
  console.log((cond ? "  ✓ " : "  ✗ FAIL ") + msg);
  if (!cond) failures++;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Pull every `run:` value out of ci.yml — single-line strings AND `|`/`>` block
//    scalars (the YAML forms this workflow actually uses). No YAML library: ci.yml's
//    `run:` shape is simple enough that a small indentation-aware scan is more honest
//    than depending on an undeclared transitive package.
// ───────────────────────────────────────────────────────────────────────────
function extractRunBlocks(yamlText: string): string[] {
  const lines = yamlText.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2].trim();
    if (rest === "" || rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j];
        if (line.trim() === "") { j++; continue; }
        const lineIndent = (line.match(/^(\s*)/) ?? ["", ""])[1].length;
        if (lineIndent <= indent) break;
        blockLines.push(line);
        j++;
      }
      blocks.push(blockLines.join("\n"));
      i = j - 1;
    } else {
      let cmd = rest;
      if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
        cmd = cmd.slice(1, -1);
      }
      blocks.push(cmd);
    }
  }
  return blocks;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. From a shell command string, pull out `npm run <name>` targets and direct
//    `scripts/*.{ts,tsx,mts,mjs,py}` paths.
// ───────────────────────────────────────────────────────────────────────────
const NPM_RUN_RE = /npm run ([A-Za-z0-9:_.-]+)/g;
const SCRIPT_PATH_RE = /scripts\/[A-Za-z0-9/_.-]+\.(?:ts|tsx|mts|mjs|py)/g;

function namesFrom(cmd: string): { npmScripts: Set<string>; scriptPaths: Set<string> } {
  const npmScripts = new Set<string>();
  const scriptPaths = new Set<string>();
  let m: RegExpExecArray | null;
  NPM_RUN_RE.lastIndex = 0;
  while ((m = NPM_RUN_RE.exec(cmd))) npmScripts.add(m[1]);
  SCRIPT_PATH_RE.lastIndex = 0;
  while ((m = SCRIPT_PATH_RE.exec(cmd))) scriptPaths.add(m[0]);
  return { npmScripts, scriptPaths };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Resolve every ci.yml `run:` block, following `npm run` chains to any depth
//    against package.json's scripts map, into the full set of reachable script paths.
// ───────────────────────────────────────────────────────────────────────────
function computeReachableScriptPaths(ciYamlText: string, pkgScripts: Record<string, string>): Set<string> {
  const reachable = new Set<string>();
  const visitedNpmScripts = new Set<string>();

  function visitCommand(cmd: string) {
    const { npmScripts, scriptPaths } = namesFrom(cmd);
    for (const p of scriptPaths) reachable.add(p);
    for (const name of npmScripts) visitNpmScript(name);
  }
  function visitNpmScript(name: string) {
    if (visitedNpmScripts.has(name)) return;
    visitedNpmScripts.add(name);
    const cmd = pkgScripts[name];
    if (cmd) visitCommand(cmd);
  }

  for (const block of extractRunBlocks(ciYamlText)) visitCommand(block);
  return reachable;
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Pure violation checks (parameterized so the self-test below can exercise them
//    with synthetic input, without writing throwaway files into the real repo).
// ───────────────────────────────────────────────────────────────────────────
type Violation = { path: string; reason: string };

function findUncoveredOrMiswired(
  matchedFiles: string[],
  reachable: Set<string>,
  exclusions: Record<string, string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const path of matchedFiles) {
    const isReachable = reachable.has(path);
    const isExcluded = Object.prototype.hasOwnProperty.call(exclusions, path);
    if (isReachable && isExcluded) {
      violations.push({ path, reason: "listed in mcp-verify-exclusions.json but IS reachable from CI — remove the exclusion" });
    } else if (!isReachable && !isExcluded) {
      violations.push({ path, reason: "not reachable from any CI step and not listed in scripts/mcp-verify-exclusions.json" });
    }
  }
  return violations;
}

function findExclusionProblems(
  exclusions: Record<string, string>,
  reachable: Set<string>,
  fileExists: (p: string) => boolean,
): Violation[] {
  const problems: Violation[] = [];
  for (const path of Object.keys(exclusions)) {
    if (!fileExists(path)) {
      problems.push({ path, reason: "exclusion lists a file that does not exist" });
    } else if (reachable.has(path)) {
      problems.push({ path, reason: "exclusion lists a file that IS reachable from CI" });
    }
  }
  return problems;
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────
function main() {
  const ciYamlText = readFileSync(CI_YAML_PATH, "utf8");
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { scripts?: Record<string, string> };
  const pkgScripts = pkg.scripts ?? {};
  const reachable = computeReachableScriptPaths(ciYamlText, pkgScripts);

  const exclusions: Record<string, string> = existsSync(EXCLUSIONS_PATH)
    ? JSON.parse(readFileSync(EXCLUSIONS_PATH, "utf8"))
    : {};

  // ---- Self-test FIRST: prove the guard actually catches what it claims to, using
  // synthetic input only — no file is written to or removed from the real repo. ----
  console.log("Self-test (synthetic input, no filesystem changes)");
  {
    const fakeOrphan = "scripts/verify-mcp-__selftest_unreachable__.ts";
    const selfTestReachable = new Set(reachable); // real reachable set; fakeOrphan is NOT in it
    const v1 = findUncoveredOrMiswired([fakeOrphan], selfTestReachable, {});
    ok(v1.some((v) => v.path === fakeOrphan), "an unreachable, unexcluded script is flagged as a violation");

    const v1b = findUncoveredOrMiswired([fakeOrphan], selfTestReachable, { [fakeOrphan]: "fake reason" });
    ok(v1b.length === 0, "the same script is NOT flagged once validly excluded");

    const someRealReachablePath = [...reachable][0];
    ok(Boolean(someRealReachablePath), "sanity: at least one real script is reachable, for the next self-checks");
    const v2 = findUncoveredOrMiswired([someRealReachablePath], reachable, { [someRealReachablePath]: "bogus exclusion" });
    ok(
      v2.some((v) => v.path === someRealReachablePath),
      "a reachable script wrongly listed as excluded is flagged",
    );

    const p1 = findExclusionProblems({ "scripts/does-not-exist-__selftest__.ts": "x" }, reachable, () => false);
    ok(p1.some((p) => p.path === "scripts/does-not-exist-__selftest__.ts"), "an exclusion for a nonexistent file is flagged");

    const p2 = findExclusionProblems({ [someRealReachablePath]: "x" }, reachable, () => true);
    ok(p2.some((p) => p.path === someRealReachablePath), "an exclusion for a reachable file is flagged");
  }

  // ---- Real check against the live repo ----
  console.log("\nLive coverage check");
  const matchedFiles = readdirSync(SCRIPTS_DIR)
    .filter((name) => GLOB_PATTERNS.some((re) => re.test(name)))
    .map((name) => `${SCRIPTS_DIR_NAME}/${name}`)
    .sort();
  ok(matchedFiles.length > 0, `found ${matchedFiles.length} matching script(s) under scripts/`);

  const violations = findUncoveredOrMiswired(matchedFiles, reachable, exclusions);
  for (const v of violations) ok(false, `${v.path}: ${v.reason}`);
  ok(violations.length === 0, "every matched script is reachable from CI or validly excluded");

  const exclusionProblems = findExclusionProblems(exclusions, reachable, (p) => existsSync(join(ROOT, p)));
  for (const p of exclusionProblems) ok(false, `exclusion ${p.path}: ${p.reason}`);
  ok(exclusionProblems.length === 0, "every exclusion entry points to a real, non-reachable file");

  console.log(failures === 0 ? "\n✅ ALL MCP CI-COVERAGE CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
