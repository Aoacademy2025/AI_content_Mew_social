// Run with: npx tsx scripts/verify-job-funnel.ts
// Proves the VideoJob-derived creation funnel (summarizeJobFunnel): counts are monotonic
// non-increasing, `created` >= every later step, `done` == status-done jobs, conversion never
// exceeds 100%, and @aoacademy internal accounts are excluded UPSTREAM (before summarize) — the
// route filters them out, so a team-owned job must not inflate the funnel.
import { summarizeJobFunnel, type JobFunnelRow } from "../src/app/api/admin/insights/route";

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("❌ FAIL " + m); process.exit(1); }
  console.log("✓ PASS " + m);
  passed++;
}

type OwnedJob = JobFunnelRow & { email: string };

// Synthetic jobs across every milestone (progress 0/55/65/75/100) + a mix of statuses.
// One job is owned by an @aoacademy internal account and MUST be excluded upstream.
const rawJobs: OwnedJob[] = [
  { userId: "u1", email: "creator1@gmail.com", status: "done", progress: 100 },
  { userId: "u2", email: "creator2@gmail.com", status: "failed", progress: 75 }, // reached render, not done
  { userId: "u3", email: "creator3@gmail.com", status: "failed", progress: 65 }, // reached config
  { userId: "u4", email: "student@kalangsang.com", status: "processing", progress: 55 }, // reached b-roll (workshop student = KEPT)
  { userId: "u5", email: "creator5@gmail.com", status: "failed", progress: 0 }, // created only
  { userId: "u6", email: "creator6@gmail.com", status: "done", progress: 100 },
  { userId: "team1", email: "staff@aoacademy.com", status: "done", progress: 100 }, // internal → EXCLUDE
];

// Mirror the route's upstream exclusion (internal = email contains @aoacademy).
const internalUserIds = new Set(
  rawJobs.filter((j) => j.email.toLowerCase().includes("@aoacademy")).map((j) => j.userId),
);
const jobs: JobFunnelRow[] = rawJobs
  .filter((j) => !internalUserIds.has(j.userId))
  .map((j) => ({ userId: j.userId, status: j.status, progress: j.progress }));

const { funnel, funnelMode, funnelRuns } = summarizeJobFunnel(jobs);

// funnelMode identifies the source as VideoJob.
assert(funnelMode === "job", `funnelMode is "job" (got "${funnelMode}")`);

// Internal @aoacademy job excluded upstream → 6 non-internal jobs, not 7.
assert(funnel[0].count === 6, `created counts only the 6 non-internal jobs (got ${funnel[0].count})`);
assert(funnelRuns === funnel[0].count, `funnelRuns == created count (${funnelRuns})`);

// Expected reach counts.
const byKey = Object.fromEntries(funnel.map((f) => [f.key, f.count]));
assert(byKey.broll === 5, `broll (progress>=55) = 5 (got ${byKey.broll})`); // all but the progress-0 job
assert(byKey.config === 4, `config (progress>=65) = 4 (got ${byKey.config})`);
assert(byKey.render === 3, `render (progress>=75) = 3 (got ${byKey.render})`);
assert(byKey.done === 2, `done (status==="done") = 2 (got ${byKey.done})`);

// done count equals jobs whose status is exactly "done" (non-internal).
const doneStatus = jobs.filter((j) => j.status === "done").length;
assert(byKey.done === doneStatus, `done step == count of status="done" jobs (${doneStatus})`);

// Monotonic non-increasing: every step <= the previous step.
for (let i = 1; i < funnel.length; i++) {
  assert(funnel[i].count <= funnel[i - 1].count, `step "${funnel[i].key}" count (${funnel[i].count}) <= "${funnel[i - 1].key}" (${funnel[i - 1].count})`);
}

// created >= every other step.
assert(funnel.slice(1).every((s) => s.count <= funnel[0].count), "created >= every later step");

// Conversion never exceeds 100 and drop-off never negative.
assert(funnel.every((s) => s.conversionPct <= 100 && s.conversionPct >= 0), "conversionPct within [0,100] for every step");
assert(funnel.every((s) => s.dropOffPct >= 0 && s.dropOffPct <= 100), "dropOffPct within [0,100] for every step");
assert(funnel[0].conversionPct === 100 && funnel[0].dropOffPct === 0, "first step is the 100% base (no drop-off)");

// If the internal job were NOT excluded, created would be 7 and done 3 — proves exclusion matters.
const unfiltered = summarizeJobFunnel(rawJobs.map((j) => ({ userId: j.userId, status: j.status, progress: j.progress })));
assert(unfiltered.funnel[0].count === 7, "sanity: without exclusion created would be 7 (exclusion removed 1)");

// Empty input → all zeros, no NaN, safe base.
const empty = summarizeJobFunnel([]);
assert(empty.funnelRuns === 0 && empty.funnel.every((s) => s.count === 0), "empty jobs → all counts 0, funnelRuns 0");
assert(empty.funnel.every((s) => Number.isFinite(s.conversionPct) && Number.isFinite(s.dropOffPct)), "empty jobs → no NaN in conversion/drop-off");

console.log(`\n${passed} checks passed`);
