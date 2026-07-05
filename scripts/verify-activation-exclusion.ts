// Run with: npx tsx scripts/verify-activation-exclusion.ts
// Proves the activation funnel EXCLUDES internal @aoacademy accounts from every count while KEEPING
// everyone else — including workshop students (คลังแสง) and users with no email — and that
// "startedPipeline" is server-truth VideoJob creators, not v1-only telemetry.
import { computeActivationFunnel } from "../src/app/api/admin/insights/route";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ FAIL " + m); process.exit(1); }
  console.log("✓ PASS " + m);
  passed++;
}

const since = new Date("2026-07-01T00:00:00Z");
const users = [
  { id: "u1", email: "creator1@gmail.com", createdAt: new Date("2026-07-03") },       // in window
  { id: "u2", email: "creator2@gmail.com", createdAt: new Date("2026-06-20") },       // before window
  { id: "u3", email: "student@kalangsang.com", createdAt: new Date("2026-07-04") },   // workshop student → KEEP
  { id: "team1", email: "staff@aoacademy.com", createdAt: new Date("2026-07-04") },   // internal → EXCLUDE
  { id: "team2", email: "admin@aoacademy.co.th", createdAt: new Date("2026-07-02") }, // internal (subdomain tld) → EXCLUDE
  { id: "u4", email: null, createdAt: new Date("2026-07-05") },                        // no email → not internal, KEEP
];

const af = computeActivationFunnel({
  users,
  openedUserIds: ["u1", "u2", "team1", "u3", null], // team1 + null must not count
  jobUserIds: ["u1", "u3", "team1"],                 // team1 must not count
  completedByUser: [
    { userId: "u1", count: 3 },     // repeat creator (kept)
    { userId: "u3", count: 1 },     // workshop student, first video (kept)
    { userId: "team1", count: 5 },  // internal repeat (excluded)
  ],
  since,
});

assert(af.internalTeam === 2, `internalTeam = 2 (@aoacademy incl. subdomain tld) — got ${af.internalTeam}`);
assert(af.signups === 4, `signups = 6 users − 2 internal = 4 (got ${af.signups})`);
assert(af.openedEditor === 3, `openedEditor excludes team1 + null → u1,u2,u3 = 3 (got ${af.openedEditor})`);
assert(af.startedPipeline === 2, `startedPipeline (server-truth VideoJob creators) excludes team1 → u1,u3 = 2 (got ${af.startedPipeline})`);
assert(af.completedFirstVideo === 2, `completedFirstVideo excludes team1 → u1,u3 = 2 (got ${af.completedFirstVideo})`);
assert(af.repeatCreators === 1, `repeatCreators (count>=2, non-internal) → only u1 = 1 (got ${af.repeatCreators})`);
assert(af.windowSignups === 3, `windowSignups (non-internal, createdAt>=since) → u1,u3,u4 = 3 (got ${af.windowSignups})`);

// Explicit acceptance check: the workshop student u3 is KEPT in every stage it appears in.
assert(af.startedPipeline >= 1 && af.completedFirstVideo >= 1, "workshop student (non-@aoacademy) is KEPT, not excluded");

// Exclusion actually matters: without it, signups would be all 6 users.
const noInternal = computeActivationFunnel({
  users: users.filter((u) => !(u.email ?? "").includes("@aoacademy")),
  openedUserIds: [], jobUserIds: [], completedByUser: [], since,
});
assert(noInternal.internalTeam === 0 && noInternal.signups === 4, "sanity: a set with no @aoacademy accounts has internalTeam 0");
assert(users.length === 6 && af.signups === users.length - 2, "sanity: exclusion removed exactly the 2 internal accounts");

// Empty input → all zeros, no throw.
const empty = computeActivationFunnel({ users: [], openedUserIds: [], jobUserIds: [], completedByUser: [], since });
assert(empty.signups === 0 && empty.internalTeam === 0 && empty.repeatCreators === 0, "empty input → all zeros");

// MCP/chat creators never open the web editor, so openedUserIds is telemetry-only and can be a
// STRICT subset of jobUserIds. Tier-1 fix: openedEditor must be the union (engaged >= started),
// never < startedPipeline — otherwise the funnel shows >100% conversion / negative drop-off.
const mcpUsers = [
  { id: "m1", email: "webuser@gmail.com", createdAt: new Date("2026-07-03") },
  { id: "m2", email: "mcponly@gmail.com", createdAt: new Date("2026-07-03") }, // MCP-only: job, no editor_opened
];
const mcpAf = computeActivationFunnel({
  users: mcpUsers,
  openedUserIds: ["m1"],           // m2 never opened the web editor
  jobUserIds: ["m1", "m2"],        // but m2 DID create a job via MCP/chat
  completedByUser: [],
  since,
});
assert(mcpAf.startedPipeline === 2, `startedPipeline counts both web + MCP creators → 2 (got ${mcpAf.startedPipeline})`);
assert(mcpAf.openedEditor === 2, `openedEditor unions in the MCP-only creator (m2) → 2 (got ${mcpAf.openedEditor})`);
assert(mcpAf.openedEditor >= mcpAf.startedPipeline, `monotonic: openedEditor (${mcpAf.openedEditor}) >= startedPipeline (${mcpAf.startedPipeline})`);

console.log(`\n${passed} checks passed`);
