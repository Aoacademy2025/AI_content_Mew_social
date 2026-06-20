// Verify disk-watch sweep logic against a throwaway temp dir (no real /tmp or df).
// Run: npx tsx scripts/verify-disk-watch.ts
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";
import { sweepOrphans, entrySizeMb, TMP_ORPHAN_PREFIXES } from "../src/lib/disk-watch";

let pass = 0;
const checks: Array<[string, () => void]> = [];
function check(name: string, fn: () => void) { checks.push([name, fn]); }

const now = Date.parse("2026-06-20T12:00:00Z");
const OLD = now - 24 * 60 * 60 * 1000; // 24h ago
const FRESH = now - 60 * 1000; // 1 min ago
const MAX_AGE = 12 * 60 * 60 * 1000; // 12h

const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-watch-verify-"));

function mkfile(name: string, mtime: number, bytes = 1024) {
  const p = path.join(root, name);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  fs.utimesSync(p, new Date(mtime), new Date(mtime));
  return p;
}
function mkdirOld(name: string, mtime: number) {
  const p = path.join(root, name);
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, "inner"), Buffer.alloc(2048));
  fs.utimesSync(p, new Date(mtime), new Date(mtime));
  return p;
}

// Fixtures
const oldOrphan = mkfile("remotion-bundle-abc", OLD);
const freshOrphan = mkfile("remotion-bundle-fresh", FRESH);
const oldChromeDir = mkdirOld("puppeteer_dev_chrome_profile-xyz", OLD);
const unrelated = mkfile("important-data.db", OLD);
// symlink whose name matches a prefix but points elsewhere — must NOT be followed/deleted
const linkTarget = mkfile("link-target", OLD);
const orphanLink = path.join(root, "react-motion-render-link");
fs.symlinkSync(linkTarget, orphanLink);
fs.lutimesSync?.(orphanLink, new Date(OLD), new Date(OLD));

const result = sweepOrphans(root, TMP_ORPHAN_PREFIXES, MAX_AGE, now);

check("old orphan file deleted", () => assert.ok(!fs.existsSync(oldOrphan)));
check("old orphan dir deleted", () => assert.ok(!fs.existsSync(oldChromeDir)));
check("fresh orphan kept (too new)", () => assert.ok(fs.existsSync(freshOrphan)));
check("unrelated file kept (no prefix)", () => assert.ok(fs.existsSync(unrelated)));
check("symlink not followed (target intact)", () => assert.ok(fs.existsSync(linkTarget)));
check("freed > 0 and items recorded", () => {
  assert.ok(result.freedMb >= 0);
  assert.ok(result.items.length === 2, `expected 2 deleted, got ${result.items.length}`);
});
check("entrySizeMb on missing path = 0", () => assert.strictEqual(entrySizeMb(path.join(root, "nope")), 0));
check("empty/unreadable dir = no-op", () => {
  const r = sweepOrphans(path.join(root, "does-not-exist"), TMP_ORPHAN_PREFIXES, MAX_AGE, now);
  assert.strictEqual(r.freedMb, 0);
  assert.strictEqual(r.items.length, 0);
});

for (const [name, fn] of checks) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); }
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nverify-disk-watch: ${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
