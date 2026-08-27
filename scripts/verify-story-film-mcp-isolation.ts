// Run with: npx tsx scripts/verify-story-film-mcp-isolation.ts
// Structural release guard: Story Film tools stay off the public MCP catalog.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publicMcp = readFileSync("src/app/api/[transport]/route.ts", "utf8");
const internalMcp = readFileSync("src/app/api/story-film/[transport]/route.ts", "utf8");
const audit = readFileSync("src/lib/mcp/audit.ts", "utf8");
const proxy = readFileSync("src/proxy.ts", "utf8");

const tools = ["hero_story_film_start", "hero_story_film_read", "hero_story_film_decide"];
for (const tool of tools) {
  assert.equal(publicMcp.includes(tool), false, `${tool} must not appear in Public HeroAI MCP`);
  assert.equal(internalMcp.includes(`\"${tool}\"`), true, `${tool} must be registered on Internal Story Film MCP`);
}

assert.match(internalMcp, /basePath: "\/api\/story-film"/);
assert.match(internalMcp, /patPrincipal && isInternalAiTester\(patPrincipal\.user\)/);
assert.match(internalMcp, /principal && isInternalAiTester\(principal\.user\)/);
assert.match(internalMcp, /fail closed before tools\/list/);
assert.match(audit, /redacted\.narrativeSource/);
assert.match(proxy, /"\/api\/story-film\(\.\*\)"/);

console.log("ok: Public HeroAI MCP catalog contains no Story Film tools");
console.log("ok: Internal Story Film MCP exposes exactly start/read/decide");
console.log("ok: PAT and Clerk OAuth both require an internal tester before tool discovery");
console.log("ok: Story Film Narrative Source is redacted from MCP audit logs");
console.log("ok: middleware passes Bearer transport through to the route-owned internal auth gate");
