/**
 * T6 — Failure transparency and QA surfacing (plan 2026-10-01-mcp-upgrade-p0-p1, Global
 * Constraints "Failure fields"). `get_video_status` for a failed job must return
 * `{errorCode, errorProvider?, message, userAction, refunded, refundPending}`:
 *   - errorCode === null (every legacy NULL-code row, audit 2026-10-01) reads as "internal"
 *     at READ time, never written back.
 *   - message/userAction reuse the EXISTING Editor v2 Thai copy map (`classifyFailure` +
 *     `failureViewCopy`, `_v2/failure-view.ts`) — no second copy of that taxonomy.
 *     `message` is that map's heading (GENERIC_ERROR_COPY with no code) and NEVER the stored
 *     errorMessage, which is diagnostic text that can carry HTTP status lines, upstream body
 *     fragments and server paths (PR-A security review S1). The legacy `error` field is
 *     unchanged (pre-existing, parked by the session).
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
  const { deriveFailedJobFields } = await import("../src/lib/mcp/video-job");

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
  ok(system?.message === "ประกอบวิดีโอไม่สำเร็จ", "system class: message is failure-view's render-step heading");
  ok(system?.message !== "เรนเดอร์ไม่สำเร็จ (render_unknown)", "system class: message is never the stored errorMessage (S1)");
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
  ok(byok?.message === "เชื่อมต่อบริการภายนอกไม่สำเร็จ", "byok class: message is failure-view's provider-key heading, not the stored errorMessage");
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
  ok(quota?.message === "โควต้าเรนเดอร์ของแพ็กเกจใช้ครบแล้ว", "quota class: message is failure-view's plan-quota heading");
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
  ok(legacy?.message === GENERIC_ERROR_COPY, "legacy row reads the generic copy as its message");
  ok(legacy?.userAction === INTERNAL_USER_ACTION, "legacy row gets the session-authored internal userAction, not a bare generic");

  // A null errorCode with NO stored errorMessage either (the worker-restart direct-update
  // path never calls failJob, so it never gets a code — this must still resolve safely).
  await makeFailedJob("ff-legacy-no-message", { errorCode: null, errorMessage: null });
  const legacyNoMessage = await getVideoJobStatusTool(user.id, "ff-legacy-no-message");
  ok(legacyNoMessage?.errorCode === "internal" && legacyNoMessage?.message === GENERIC_ERROR_COPY, "null errorCode + null errorMessage still resolves to internal/generic, never leaks `null`");

  // ── 2b. S1: a raw diagnostic errorMessage never reaches message/userAction ──────────────
  // classifyUnknownStepFailure stores "<prefix> (<code>): <scrubbed cause>"; scrubSecrets
  // removes keys/tokens only, so HTTP status lines, upstream bodies and paths survive into
  // errorMessage. None of that may reach the customer-facing fields, coded or not.
  const LEAKY_ERROR_MESSAGE =
    'เรนเดอร์ไม่สำเร็จ (render_failed): HTTP 500 Internal Server Error POST /api/videos/render '
    + '/var/www/ai-content/public/renders/u1/x.mp4 {"error":"upstream exploded","stack":"at run-render.ts:255"}';
  const LEAK_MARKERS = ["HTTP 500", "/var/www", '{"error"', "upstream exploded", "run-render.ts", "/api/videos/render"];
  await makeFailedJob("ff-leak-coded", {
    errorCode: "render_failed",
    errorMessage: LEAKY_ERROR_MESSAGE,
    currentStep: "render",
  });
  await makeFailedJob("ff-leak-null-code", { errorCode: null, errorMessage: LEAKY_ERROR_MESSAGE });
  await makeFailedJob("ff-leak-avatar", {
    errorCode: "fatal",
    errorProvider: "heygen",
    errorMessage: LEAKY_ERROR_MESSAGE,
    currentStep: "avatar",
    inputJson: avatarInput(),
  });
  for (const id of ["ff-leak-coded", "ff-leak-null-code", "ff-leak-avatar"]) {
    const leak = await getVideoJobStatusTool(user.id, id);
    ok(typeof leak?.message === "string" && leak.message.length > 0, `${id}: message is a non-empty string`);
    ok(leak?.message !== LEAKY_ERROR_MESSAGE, `${id}: message is not the stored errorMessage`);
    for (const marker of LEAK_MARKERS) {
      ok(
        !leak?.message.includes(marker) && !leak?.userAction.includes(marker),
        `${id}: ${JSON.stringify(marker)} from the stored errorMessage never appears in message/userAction`,
      );
    }
  }
  const leakCoded = await getVideoJobStatusTool(user.id, "ff-leak-coded");
  ok(leakCoded?.message === "ประกอบวิดีโอไม่สำเร็จ", "coded leaky job: message is the render-step heading");
  const leakNullCode = await getVideoJobStatusTool(user.id, "ff-leak-null-code");
  ok(leakNullCode?.message === GENERIC_ERROR_COPY && leakNullCode.errorCode === "internal", "null-code leaky job: message is the generic copy, code internal");

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

  // ── 3b. Owner scope on the RenderJob refund query (PR-A security low S4) ──────────────
  // A RenderJob that names this job as parent but belongs to ANOTHER user must never decide
  // this job's refund state — the query is scoped to the job owner, so a chain-building bug
  // (T8 passes multi-job chains) can never read another tenant's charge state.
  const otherUser = await prisma.user.create({
    data: { id: "ff-other-user", name: "Other Tenant", email: "ff-other@example.com", plan: "PRO" },
  });
  await makeFailedJob("ff-foreign-render-job", { errorCode: "render_unknown", fundingState: "refunded" });
  await prisma.renderJob.create({
    data: {
      id: "rj-foreign-tenant",
      userId: otherUser.id,
      parentJobId: "ff-foreign-render-job",
      type: "RENDER",
      status: "DONE",
      payload: "{}",
      reservedQuota: true,
      reservedMinutes: 1,
    },
  });
  const foreignRenderJob = await getVideoJobStatusTool(user.id, "ff-foreign-render-job");
  ok(
    foreignRenderJob?.refunded === true,
    "owner scope: another tenant's reservedQuota RenderJob pointing at this job never flips refunded",
  );

  // The query still takes a LIST of chain job ids (T8 contract): a charged RenderJob under
  // the second job of an owned chain makes the first job's failure read as not refunded.
  await prisma.videoJob.create({
    data: { id: "ff-chain-export", userId: user.id, status: "done", progress: 100, inputJson: baseInput() },
  });
  await prisma.renderJob.create({
    data: {
      id: "rj-chain-export",
      userId: user.id,
      parentJobId: "ff-chain-export",
      type: "BURN",
      status: "DONE",
      payload: "{}",
      reservedQuota: true,
      reservedMinutes: 1,
    },
  });
  const chainHead = await prisma.videoJob.findUniqueOrThrow({ where: { id: "ff-refund-settled" } });
  const chainFields = await deriveFailedJobFields(chainHead, ["ff-refund-settled", "ff-chain-export"]);
  ok(chainFields.refunded === false, "chain list: an owned charged RenderJob under any chain job id reads as not refunded");
  const soloFields = await deriveFailedJobFields(chainHead, ["ff-refund-settled"]);
  ok(soloFields.refunded === true, "chain list: the same job alone (no charged child) still reads as refunded");

  // ── 3c. errorProvider: kept for BYOK providers, omitted for managed ones ─────────────
  // runpod (Hero AI Image) and omnivoice (Hero AI Voice) are internal vendors sold under
  // our own names; naming them helps no customer fix anything (PR-A security low S5).
  // T8 (R-T8-3): matched by provider family, so a variant label never leaks the vendor.
  for (const managed of ["runpod", "omnivoice", "runpod-hero-image", "OmniVoice-hostinger"]) {
    await makeFailedJob(`ff-managed-${managed}`, {
      errorCode: "transient",
      errorProvider: managed,
      currentStep: managed.toLowerCase().startsWith("runpod") ? "stock" : "tts",
    });
    const r = await getVideoJobStatusTool(user.id, `ff-managed-${managed}`);
    ok(r?.errorCode === "transient" && !("errorProvider" in (r ?? {})), `managed provider ${managed}: errorProvider is omitted`);
  }
  await makeFailedJob("ff-byok-heygen", {
    errorCode: "invalid_key",
    errorProvider: "heygen",
    currentStep: "avatar",
    inputJson: avatarInput(),
  });
  const byokHeygen = await getVideoJobStatusTool(user.id, "ff-byok-heygen");
  ok(byokHeygen?.errorProvider === "heygen", "BYOK provider heygen: errorProvider is kept");

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
  // The remaining bare-string failJob calls are confined to broll-rerender/upload — modes
  // MCP never sends. T8 (R-T8-1) made the export path MCP-reachable (the server-chained
  // export), so its 5 bare-string calls now carry codes: 12 → 7. Fail loudly if a NEW
  // bare-string failJob call appears (a crude but effective guard: count bare-string calls
  // total and compare to the known, reviewed set below).
  const bareStringFailJobCalls = orchestratorSrc.match(/failJob\(jobId, "[^{]/g) ?? [];
  ok(
    bareStringFailJobCalls.length === 7,
    `orchestrator.ts: exactly the 7 known out-of-scope (broll-rerender/upload) bare-string failJob calls remain — got ${bareStringFailJobCalls.length} (a new one outside those modes needs a code, per this task's scope)`,
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
