// Proof that runTool's audit classifier (isInBandError) labels a tool result by the
// VALUE of `error`, not by key PRESENCE. Regression: get_video_status's job branch
// always returns `error: job.errorMessage ?? null`, so a SUCCESSFUL job-status poll
// (error: null) was being mislabeled "error" in ToolCallAudit. No DB needed — pure logic.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-mcp-audit-status.ts
import { isInBandError } from "../src/lib/mcp/audit";
import { readFileSync } from "node:fs";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// --- The exact return shapes the MCP tools produce (src/app/api/[transport]/route.ts + tools.ts) ---

// get_video_status, job branch, job finished OK → carries `error: null`. THE REGRESSION.
assert(isInBandError({ kind: "job", jobId: "j1", status: "done", currentStep: "burn", progress: 100, videoUrl: "/x.mp4", error: null }) === false,
  "successful job-status poll (error: null) is classified OK, not error");

// get_video_status, job branch, job actually failed → real in-band error.
assert(isInBandError({ kind: "job", jobId: "j2", status: "failed", currentStep: null, progress: 0, videoUrl: null, error: "render failed" }) === true,
  "failed job (error: 'render failed') is classified error");

// get_video_status, video branch found, and the none/not-found branch — neither has an error key.
assert(isInBandError({ kind: "video", found: true, videoId: "v1", status: "COMPLETED", hasDownload: true }) === false,
  "video-status found result is OK");
assert(isInBandError({ kind: "none", found: false, id: "render-123" }) === false,
  "not-found result is OK");

// create_video_job success vs its in-band guard errors.
assert(isInBandError({ jobId: "j3", status: "queued", message: "งานเข้าคิวแล้ว" }) === false,
  "create_video_job success is OK");
for (const code of ["missing_key", "quota_exceeded", "too_many_jobs", "duplicate", "plan_required", "internal_error"]) {
  assert(isInBandError({ error: code, message: "..." }) === true, `create_video_job '${code}' is classified error`);
}

// get_current_user / list_my_videos: plain success payloads with no error key.
assert(isInBandError({ email: "a@b.c", plan: "PRO" }) === false, "get_current_user success is OK");
assert(isInBandError([{ id: "v1" }, { id: "v2" }]) === false, "list_my_videos array result is OK");

// Edge cases: error present but undefined/empty-string semantics, and non-objects.
assert(isInBandError({ error: undefined }) === false, "error: undefined is OK (no error)");
assert(isInBandError({ error: "" }) === true, "error: '' (empty string) is still an error value");
assert(isInBandError(null) === false, "null result is OK");
assert(isInBandError("done") === false, "string result is OK");

// Public consumers must never expose the internal waiting_provider lifecycle value.
const webStatusRoute = readFileSync("src/app/api/videos/jobs/[id]/route.ts", "utf8");
const mcpRoute = readFileSync("src/app/api/[transport]/route.ts", "utf8");
const jobsRoute = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const insightsRoute = readFileSync("src/app/api/admin/insights/route.ts", "utf8");
assert(webStatusRoute.includes("toPublicVideoJobStatus(job.status)"), "web job status normalizes waiting_provider");
assert(mcpRoute.includes("toPublicVideoJobStatus(job.status)"), "MCP job status normalizes waiting_provider");
assert(webStatusRoute.includes("...VIDEO_JOB_INFLIGHT_STATUSES"), "DELETE accepts every shared in-flight status");
assert((jobsRoute.match(/\.\.\.VIDEO_JOB_INFLIGHT_STATUSES/g) ?? []).length === 3, "all three web in-flight limits use the shared status set");
assert(mcpRoute.includes("...VIDEO_JOB_INFLIGHT_STATUSES"), "MCP in-flight limit includes provider waits");
assert(insightsRoute.includes("waitingProvider:"), "admin insights reports waiting-provider count separately");

console.log(`\n${passed} assertions passed ✅`);
