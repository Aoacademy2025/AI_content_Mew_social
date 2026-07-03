import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { prisma } from "@/lib/prisma";
import { parseVideoJobOutput } from "@/lib/mcp/video-job";

// GET /api/videos/jobs/[id] — Editor v2 background-render status poll (owner only).
// Output is included only when done, parsed through the versioned reader (v1 + v2).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const job = await prisma.videoJob.findFirst({ where: { id, userId: user.id } });
    if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({
      id: job.id,
      status: job.status, // queued | processing | done | failed | canceled
      currentStep: job.currentStep,
      progress: job.progress,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      ...(job.status === "done" ? { output: parseVideoJobOutput(job.outputJson) } : {}),
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
    const res = await prisma.videoJob.updateMany({
      where: { id, userId: user.id, status: { in: ["queued", "processing"] } },
      data: { status: "canceled", finishedAt: new Date(), errorMessage: "canceled by user (editor v2)" },
    });
    if (res.count !== 1) {
      return NextResponse.json({ error: "not_cancelable", message: "งานจบไปแล้ว — ยกเลิกไม่ได้" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/videos/jobs/:id] cancel error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// PATCH /api/videos/jobs/[id] — จอแต่งซับ re-composite อวตารแล้วบันทึก videoUrl ใหม่ลง output
// (ไม่งั้น resume งานที่ยังไม่ export จะเห็นวิดีโอตำแหน่งเก่า) · เจ้าของ + done เท่านั้น ·
// รับเฉพาะไฟล์ใน /api/renders/ (กัน URL ภายนอก/path แปลก)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const videoUrl = typeof body?.videoUrl === "string" ? body.videoUrl : "";
    if (!/^\/api\/renders\/[\w.-]+$/.test(videoUrl)) {
      return NextResponse.json({ error: "bad_video_url" }, { status: 400 });
    }

    const job = await prisma.videoJob.findFirst({ where: { id, userId: user.id, status: "done" } });
    if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let output: Record<string, unknown> = {};
    try { output = JSON.parse(job.outputJson ?? "{}") as Record<string, unknown>; } catch {}
    output.videoUrl = videoUrl;
    await prisma.videoJob.update({ where: { id: job.id }, data: { outputJson: JSON.stringify(output) } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/videos/jobs/:id] patch error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
