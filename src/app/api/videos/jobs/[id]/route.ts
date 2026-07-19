import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import {
  parseVideoJobOutput,
  toPublicVideoJobStatus,
  VIDEO_JOB_INFLIGHT_STATUSES,
} from "@/lib/mcp/video-job";
import { resolveProjectMediaState } from "@/lib/media-retention";

// GET /api/videos/jobs/[id] — Editor v2 background-render status poll (owner only).
// Output is included only when done, parsed through the versioned reader (v1 + v2).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    // PERF-APP-2: project only what this poll returns/needs. NEVER select `inputJson` (the
    // full render config) — it was hydrated on every 5s/15s poll for nothing. `outputJson`
    // is null until the job is done (written once by finishJob), so selecting it costs ~0
    // pre-done and is decoded only when status === "done".
    const job = await prisma.videoJob.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        projectId: true,
        type: true,
        status: true,
        currentStep: true,
        progress: true,
        errorMessage: true,
        errorCode: true,
        errorProvider: true,
        idempotencyKey: true,
        idempotencyFingerprint: true,
        createdAt: true,
        videoId: true,
        outputJson: true,
        mediaExpiresAt: true,
      },
    });
    if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // A still-queued editor-v2 job is waiting for the (serial) mcp-video-worker to claim it.
    // Surface a 1-based queue position so the badge can show "คิว #N" instead of a frozen 0%
    // (PERF-APP-1, editor-v2 side). Counted from the VideoJob queue (the queue an editor-v2
    // job actually waits in) — the RenderJob-queue helper is for the render-progress route.
    // Only queried when queued, so the hot processing/done poll path stays a single read.
    const queuePosition =
      job.status === "queued"
        ? (await prisma.videoJob.count({ where: { status: "queued", createdAt: { lt: job.createdAt } } })) + 1
        : null;

    const output = job.status === "done" ? parseVideoJobOutput(job.outputJson) : null;
    const mediaState = job.status === "done"
      ? await resolveProjectMediaState({
          videoUrl: output?.videoUrl,
          mediaExpiresAt: job.mediaExpiresAt,
        })
      : null;

    return NextResponse.json({
      id: job.id,
      projectId: job.projectId,
      type: job.type,
      status: toPublicVideoJobStatus(job.status), // queued | processing | done | failed | canceled
      currentStep: job.currentStep,
      progress: job.progress,
      errorMessage: job.errorMessage,
      errorCode: job.errorCode,
      errorProvider: job.errorProvider,
      idempotencyKey: job.idempotencyKey,
      idempotencyFingerprint: job.idempotencyFingerprint,
      createdAt: job.createdAt.toISOString(),
      queuePosition,
      ...(job.status === "done" ? { output, mediaState } : {}),
    });
  } catch (err) {
    console.error("[api/videos/jobs/:id] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// DELETE /api/videos/jobs/[id] — cancel a QUEUED or PROCESSING job (atomic guard).
// Queued → never starts. Processing → the worker honors the flag at the next step
// boundary (cooperative cancel; the current step finishes, nothing further starts).
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const job = await prisma.videoJob.findFirst({
      where: { id, userId: user.id },
      select: { id: true, projectId: true, type: true },
    });
    if (!job) {
      return NextResponse.json({ error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" }, { status: 409 });
    }
    const res = await prisma.videoJob.updateMany({
      where: { id, userId: user.id, status: { in: [...VIDEO_JOB_INFLIGHT_STATUSES] } },
      data: { status: "canceled", finishedAt: new Date(), errorMessage: "canceled by user (editor v2)" },
    });
    if (res.count !== 1) {
      return NextResponse.json({ error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" }, { status: 409 });
    }
    if (job.projectId) {
      if (job.type === "export") {
        await prisma.editorProject.updateMany({
          where: { id: job.projectId, userId: user.id, activeExportJobId: job.id },
          data: { status: "post", lastOpenedAt: new Date() },
        });
      } else {
        await prisma.editorProject.updateMany({
          where: { id: job.projectId, userId: user.id, activeJobId: job.id },
          data: { status: "draft", lastOpenedAt: new Date() },
        });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/videos/jobs/:id] cancel error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// PATCH /api/videos/jobs/[id] — จอแต่งซับ re-composite อวตารแล้วบันทึก videoUrl ใหม่ลง output
// (ไม่งั้น resume งานที่ยังไม่ export จะเห็นวิดีโอตำแหน่งเก่า) · เจ้าของ + done เท่านั้น ·
// รับเฉพาะไฟล์ .mp4 ใน /api/renders/ (กัน URL ภายนอก/path แปลก)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const videoUrl = typeof body?.videoUrl === "string" ? body.videoUrl : "";
    if (!/^\/api\/renders\/[\w.-]+\.mp4$/.test(videoUrl)) {
      return NextResponse.json({ error: "bad_video_url" }, { status: 400 });
    }

    const job = await prisma.videoJob.findFirst({ where: { id, userId: user.id, status: "done" } });
    if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let output: Record<string, unknown>;
    try {
      output = JSON.parse(job.outputJson ?? "{}") as Record<string, unknown>;
    } catch (parseErr) {
      // outputJson พังไม่ควรเกิดกับงาน done — ห้ามเขียนทับด้วย object เปล่า (จะทำ preview หาย)
      console.error("[api/videos/jobs/:id] patch: corrupt outputJson", parseErr);
      return NextResponse.json({ error: "corrupt_output" }, { status: 500 });
    }
    output.videoUrl = videoUrl;

    const res = await prisma.videoJob.updateMany({
      where: { id: job.id, userId: user.id, status: "done" },
      data: { outputJson: JSON.stringify(output) },
    });
    if (res.count !== 1) {
      return NextResponse.json({ error: "job_changed", message: "งานเปลี่ยนสถานะระหว่างบันทึก — ลองใหม่" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/videos/jobs/:id] patch error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
