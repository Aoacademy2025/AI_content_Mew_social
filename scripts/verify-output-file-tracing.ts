import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "node:fs";
import nextConfig from "../next.config";

const excludes = nextConfig.outputFileTracingExcludes ?? {};
assert.ok(
  Object.entries(excludes).some(([route, patterns]) => (
    route === "/**" && patterns.some((pattern) => pattern.includes("public/renders"))
  )),
  "all server routes must exclude runtime public/renders media from NFT build traces",
);
assert.equal(
  Object.values(excludes).flat().some((pattern) => (
    pattern.includes("public/") && !pattern.includes("public/renders")
  )),
  false,
  "trace exclusion must not remove music, marketing, or other required public assets",
);

const distDir = process.argv[2];
assert.ok(distDir, "usage: npx tsx scripts/verify-output-file-tracing.ts <production-build-dist-dir>");
assert.ok(existsSync(distDir!), `build output exists: ${distDir}`);
const traceFiles = globSync(join(distDir!, "server/**/*.nft.json"));
assert.ok(traceFiles.length > 0, "production-shaped build emitted route traces");
const tracedEntries = traceFiles.flatMap((file) => {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { files?: string[] };
  return (parsed.files ?? []).map((entry) => ({ file, normalized: entry.replaceAll("\\", "/") }));
});
const leaked = tracedEntries
  .filter(({ normalized }) => normalized.includes("/public/renders/"))
  .map(({ file, normalized }) => `${file}: ${normalized}`);
assert.deepEqual(leaked.slice(0, 10), [], `runtime render files leaked into NFT traces (${leaked.length})`);
assert.ok(
  tracedEntries.some(({ normalized }) => normalized.includes("/public/") && !normalized.includes("/public/renders/")),
  "non-render public assets remain traceable",
);

console.log("output-file-tracing: config ok, built traces clean, other public assets preserved");
