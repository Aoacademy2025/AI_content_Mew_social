/**
 * T6 — Failure transparency and QA surfacing (plan 2026-10-01-mcp-upgrade-p0-p1, Global
 * Constraints "Failure fields"). `get_video_status` for a failed job must return
 * `{errorCode, errorProvider?, message, userAction, refunded, refundPending}`:
 *   - errorCode === null (every legacy NULL-code row, audit 2026-10-01) reads as "internal"
 *     at READ time, never written back.
 *   - message/userAction reuse the EXISTING Editor v2 Thai copy map (`classifyFailure` +
 *     `failureViewCopy`, `_v2/failure-view.ts`) — no second copy of that taxonomy.
 *   - refundPending = reservationRefundPending.
 *   - refunded = !refundPending && fundingState ∈ {none, refunded}
 *       && no RenderJob{parentJobId ∈ chainJobIds, reservedQuota: true}.
 *   - HeyGen BYOK spend is never refundable — userAction says so whenever the job had an
 *     avatar, regardless of the failure's own code.
 *   - Every MCP-reachable create failure path (orchestrator.ts) now carries a code — no bare
 *     GENERIC_ERROR_COPY without errorCode === "internal".
 *   - T3's line-fit QA finding (`card_exceeds_line_budget`) passes through subtitleQa
 *     unchanged (no new plumbing — the existing `output?.subtitleQa ?? null` passthrough
 *     already carries it).
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "mcp-failure-fields-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });

let passed = 0;
function ok(c: boolean, m: string) {
  if (!c) { console.error("❌ " + m); process.exit(1); }
  console.log("✓ " + m);
  passed++;
}

const GENERIC_ERROR_COPY = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
const INTERNAL_USER_ACTION =
  "ระบบขัดข้องชั่วคราว ลองสั่งสร้างใหม่อีกครั้ง หากยังไม่สำเร็จติดต่อทีมงานพร้อมแจ้งรหัสงานนี้";
const AVATAR_SUFFIX =
  "ค่าใช้จ่าย HeyGen ที่ใช้ไปแล้วคิดจากบัญชี HeyGen ของคุณโดยตรงและไม่สามารถคืนได้";

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getVideoJobStatusTool } = await import("../src/lib/mcp/tools");

  const user = await prisma.user.create({
    data: { id: "ff-user", name: "Failure Fields", email: "ff@example.com", plan: "PRO" },
  });

  const baseInput = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ script: "สคริปต์ทดสอบ", ...extra });
  const avatarInput = () =>
    JSON.stringify({ script: "สคริปต์ทดสอบ", avatarMode: "bookend", avatarId: "av-1" });

  async function makeFailedJob(id: string, data: Partial<{
    errorCode: string | null;
    errorMessage: string | null;
    errorProvider: string | null;
    currentStep: string | null;
    reservationRefundPending: boolean;
    fundingState: string;
    inputJson: string;
  }>) {
    return prisma.videoJob.create({
      data: {
        id,
        userId: user.id,
        status: "failed",
        progress: 0,
        inputJson: data.inputJson ?? baseInput(),
        errorCode: data.errorCode ?? null,
        errorMessage: data.errorMessage ?? null,
        errorProvider: data.errorProvider ?? null,
        currentStep: data.currentStep ?? null,
        reservationRefundPending: data.reservationRefundPending ?? false,
        fundingState: data.fundingState ?? "none",
      },
    });
  }

  // ── 1. Job Failure Class coverage: system, byok, quota ────────────────────────────────
  await makeFailedJob("ff-system", {
    errorCode: "render_unknown",
    errorMessage: "เรนเดอร์ไม่สำเร็จ (render_unknown)",
    currentStep: "render",
    fundingState: "refunded",
  });
  const system = await getVideoJobStatusTool(user.id, "ff-system");
  ok(system?.errorCode === "render_unknown", "system class: errorCode passed through verbatim");
  ok(system?.message === "เรนเดอร์ไม่สำเร็จ (render_unknown)", "system class: message is the stored Thai errorMessage");
  ok(
    system?.userAction === "ภาพ เสียง และการตั้งค่าของโปรเจกต์ยังอยู่ — กลับไปลองเรนเดอร์ใหม่ได้",
    "system class: userAction reuses failure-view's generic render-step copy",
  );
  ok(!("errorProvider" in (system ?? {})), "system class: errorProvider omitted when null");

  await makeFailedJob("ff-byok", {
    errorCode: "invalid_key",
    errorMessage: "คีย์ ElevenLabs ใช้ไม่ได้",
    errorProvider: "elevenlabs",
    currentStep: "tts",
  });
  const byok = await getVideoJobStatusTool(user.id, "ff-byok");
  ok(byok?.errorCode === "invalid_key" && byok?.errorProvider === "elevenlabs", "byok class: code + provider pass through");
  ok(
    byok?.userAction.includes("API Key ของ ElevenLabs ใช้ไม่ได้หรือหมดอายุ"),
    "byok class: userAction reuses failure-view's provider-key copy (customer's own key)",
  );

  await makeFailedJob("ff-quota", {
    errorCode: "quota_exceeded",
    errorMessage: "โควต้าเรนเดอร์ของแพ็กเกจหมด",
    currentStep: "render",
  });
  const quota = await getVideoJobStatusTool(user.id, "ff-quota");
  ok(quota?.errorCode === "quota_exceeded", "quota class: code passes through");
  ok(
    quota?.userAction.includes("อัปเกรดแพ็กเกจหรือเติมเครดิต"),
    "quota class: userAction reuses failure-view's plan-quota copy (pricing signal, not a bug)",
  );

  // ── 2. Legacy NULL errorCode row → internal ────────────────────────────────────────────
  await makeFailedJob("ff-legacy", {
    errorCode: null,
    errorMessage: GENERIC_ERROR_COPY,
  });
  const legacy = await getVideoJobStatusTool(user.id, "ff-legacy");
  ok(legacy?.errorCode === "internal", "legacy NULL-code row reads as errorCode 'internal'");
  ok(legacy?.message === GENERIC_ERROR_COPY, "legacy row keeps its stored generic message");
  ok(legacy?.userAction === INTERNAL_USER_ACTION, "legacy row gets the session-authored internal userAction, not a bare generic");

  // A null errorCode with NO stored errorMessage either (the worker-restart direct-update
  // path never calls failJob, so it never gets a code — this must still resolve safely).
  await makeFailedJob("ff-legacy-no-message", { errorCode: null, errorMessage: null });
  const legacyNoMessage = await getVideoJobStatusTool(user.id, "ff-legacy-no-message");
  ok(legacyNoMessage?.errorCode === "internal" && legacyNoMessage?.message === GENERIC_ERROR_COPY, "null errorCode + null errorMessage still resolves to internal/generic, never leaks `null`");

  // ── 3. refunded/refundPending states ───────────────────────────────────────────────────
  await makeFailedJob("ff-refund-none", { errorCode: "render_unknown", fundingState: "none" });
  const refundNone = await getVideoJobStatusTool(user.id, "ff-refund-none");
  ok(refundNone?.refunded === true && refundNone?.refundPending === false, "refund state 'none' (nothing ever funded): refunded=true, refundPending=false");

  await makeFailedJob("ff-refund-pending", { errorCode: "render_unknown", fundingState: "reserved", reservationRefundPending: true });
  const refundPending = await getVideoJobStatusTool(user.id, "ff-refund-pending");
  ok(refundPending?.refundPending === true && refundPending?.refunded === false, "refund state 'pending': refundPending=true, refunded=false regardless of fundingState");

  await makeFailedJob("ff-refund-settled", { errorCode: "render_unknown", fundingState: "refunded" });
  const refundSettled = await getVideoJobStatusTool(user.id, "ff-refund-settled");
  ok(refundSettled?.refunded === true && refundSettled?.refundPending === false, "refund state 'settled refund' (fundingState=refunded): refunded=true");

  // Kept charge via fundingState NOT in {none, refunded} (e.g. a stale "transferred" label —
  // team-verified: fundingState alone can be stale, but it still must not read as refunded).
  await makeFailedJob("ff-kept-funding-state", { errorCode: "render_unknown", fundingState: "transferred" });
  const keptFundingState = await getVideoJobStatusTool(user.id, "ff-kept-funding-state");
  ok(keptFundingState?.refunded === false, "refund state 'kept charge' via fundingState=transferred: refunded=false");

  // Kept charge via an un-reverted RenderJob{reservedQuota:true} — the money-truth source,
  // independent of (and overriding) a fundingState that already says "refunded".
  await makeFailedJob("ff-kept-reserved-quota", { errorCode: "render_unknown", fundingState: "refunded" });
  await prisma.renderJob.create({
    data: {
      id: "rj-kept-reserved-quota",
      userId: user.id,
      parentJobId: "ff-kept-reserved-quota",
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      reservedQuota: true,
      reservedMinutes: 1,
    },
  });
  const keptReservedQuota = await getVideoJobStatusTool(user.id, "ff-kept-reserved-quota");
  ok(
    keptReservedQuota?.refunded === false,
    "refund state 'kept charge' via RenderJob{reservedQuota:true}: refunded=false even though fundingState=refunded (RenderJob is money truth)",
  );

  // ── 4. Avatar job's userAction mentions HeyGen non-refundability ──────────────────────
  await makeFailedJob("ff-avatar", {
    errorCode: "SPACE_ENCRYPTION_DISABLED",
    errorProvider: "heygen",
    errorMessage: "เชื่อมต่อพื้นที่ทำงาน HeyGen ไม่สำเร็จ",
    inputJson: avatarInput(),
  });
  const avatarFailure = await getVideoJobStatusTool(user.id, "ff-avatar");
  ok(avatarFailure?.userAction.includes(AVATAR_SUFFIX), "avatar job's userAction appends the HeyGen BYOK non-refundability notice");

  // The notice is unconditional on the job having an avatar — even an internal/null-code
  // failure on an avatar job must still carry it.
  await makeFailedJob("ff-avatar-internal", { errorCode: null, inputJson: avatarInput() });
  const avatarInternal = await getVideoJobStatusTool(user.id, "ff-avatar-internal");
  ok(avatarInternal?.userAction.includes(AVATAR_SUFFIX), "avatar + internal/null code still appends the HeyGen non-refundability notice");

  // A non-avatar job never gets the notice.
  ok(!system?.userAction.includes(AVATAR_SUFFIX), "non-avatar job's userAction never mentions HeyGen");

  // ── 5. No bare generic copy without a code ─────────────────────────────────────────────
  for (const [label, r] of [
    ["system", system], ["byok", byok], ["quota", quota], ["legacy", legacy],
    ["legacyNoMessage", legacyNoMessage], ["refundNone", refundNone], ["refundPending", refundPending],
    ["refundSettled", refundSettled], ["keptFundingState", keptFundingState], ["keptReservedQuota", keptReservedQuota],
    ["avatarFailure", avatarFailure], ["avatarInternal", avatarInternal],
  ] as const) {
    if (r?.message === GENERIC_ERROR_COPY) {
      ok(r.errorCode === "internal", `${label}: GENERIC_ERROR_COPY only ever appears paired with errorCode 'internal'`);
    }
    ok(typeof r?.errorCode === "string" && r.errorCode.length > 0, `${label}: errorCode is always a non-empty string, never null`);
  }

  // ── 6. Source: every MCP-reachable create failure path now carries a code ─────────────
  const orchestratorSrc = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
  ok(
    !/failJob\(jobId, "forbidden: job\/user mismatch"\)/.test(orchestratorSrc)
      && orchestratorSrc.includes('failJob(jobId, { message: "forbidden: job/user mismatch", code: "job_owner_mismatch" })'),
    "orchestrator.ts: the create-path IDOR guard's failJob call now carries a code",
  );
  ok(
    orchestratorSrc.includes('code: "bgm_not_found"'),
    "orchestrator.ts: the create-path bgm-not-found failJob call now carries a code",
  );
  // The remaining bare-string failJob calls are confined to broll-rerender/export/upload —
  // modes the comment at the broll-rerender guard states MCP never sends. Fail loudly if a
  // NEW bare-string failJob call appears outside those blocks (a crude but effective guard:
  // count bare-string calls total and compare to the known, reviewed set below).
  const bareStringFailJobCalls = orchestratorSrc.match(/failJob\(jobId, "[^{]/g) ?? [];
  ok(
    bareStringFailJobCalls.length === 12,
    `orchestrator.ts: exactly the 12 known out-of-scope (broll-rerender/export/upload) bare-string failJob calls remain — got ${bareStringFailJobCalls.length} (a new one outside those modes needs a code, per this task's scope)`,
  );

  // ── 7. T3's line-fit QA finding passes through subtitleQa unchanged ───────────────────
  await prisma.videoJob.create({
    data: {
      id: "ff-line-fit",
      userId: user.id,
      status: "done",
      progress: 100,
      inputJson: baseInput(),
      outputJson: JSON.stringify({
        videoUrl: "/api/renders/line-fit.mp4",
        subtitleQa: {
          status: "warning",
          code: "card_exceeds_line_budget",
          timingSource: "provider_alignment",
          textExact: true,
          captionCount: 3,
          audioDurationMs: 4000,
          captionIndex: 1,
        },
      }),
    },
  });
  const lineFit = await getVideoJobStatusTool(user.id, "ff-line-fit");
  ok(
    lineFit?.subtitleQa?.status === "warning" && lineFit.subtitleQa.code === "card_exceeds_line_budget",
    "get_video_status surfaces T3's card_exceeds_line_budget finding via the existing subtitleQa passthrough",
  );

  await prisma.renderJob.deleteMany();
  await prisma.videoJob.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} MCP FAILURE-FIELDS CHECKS PASSED`);
}

main().catch((e) => { console.error(e); process.exit(1); });
