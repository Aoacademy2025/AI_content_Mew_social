import { prisma } from "@/lib/prisma";
import { isBurnAlreadyPaid } from "@/lib/clip-charge";
import { rerenderSkipEligible } from "@/lib/broll-rerender";
import { rerenderSkipBudgetAvailable } from "@/lib/rerender-skip-budget";

/**
 * T5 (ADR 0064, G4): MCP edit-and-export never creates a charge. The only paid render of an
 * Agent-created Project is its Base Render; the Burn rides `isBurnAlreadyPaid` and a B-roll
 * re-render rides the `rerenderOf` charge-skip (`rerenderSkipEligible` + the 10/user/hour
 * budget). When any of those would NOT apply, the MCP path refuses with `export_not_free`
 * instead of charging — and never creates a new charge or refund path (G3).
 *
 * Two layers:
 *  - `assertMcpRenderFree` — the pre-check before an MCP tool enqueues anything. Read-only:
 *    it writes no row and never consumes a budget slot.
 *  - `videoJobMustBeFree` — defence in depth inside /api/videos/render: a job the MCP path
 *    enqueued carries `inputJson.mcpMustBeFree = true`, and the render route FAILS such a job
 *    instead of charging it whenever neither free path applied at render time.
 */
export const MCP_EXPORT_NOT_FREE_CODE = "export_not_free";

export type McpRenderNotFreeReason = "base_not_paid" | "rerender_ineligible" | "rerender_budget_exhausted";

const NOT_FREE_COPY: Record<McpRenderNotFreeReason, { message: string; next: string }> = {
  base_not_paid: {
    message: "ส่งออกผ่านเอเจนต์ไม่ได้ เพราะไม่พบการเรนเดอร์หลักที่ชำระแล้วของวิดีโอนี้ — ระบบจะไม่ตัดโควต้าเพิ่มให้เอง",
    next: "เปิดลิงก์ editorUrl เพื่อส่งออกจากหน้าเว็บ หรือสร้างวิดีโอใหม่ด้วย create_video_job",
  },
  rerender_ineligible: {
    message: "เปลี่ยน B-roll ผ่านเอเจนต์แบบไม่เสียโควต้าไม่ได้ เพราะเสียงหรือความยาวของวิดีโอไม่ตรงกับคลิปที่ชำระแล้ว",
    next: "ยกเลิกการเปลี่ยน B-roll แล้วส่งออกเฉพาะการแก้ซับ หรือเปิดลิงก์ editorUrl เพื่อแก้ต่อในหน้าเว็บ",
  },
  rerender_budget_exhausted: {
    message: "เปลี่ยน B-roll ฟรีครบ 10 ครั้งในชั่วโมงนี้แล้ว — ระบบจะไม่ตัดโควต้าเพิ่มให้เอง",
    next: "รอประมาณหนึ่งชั่วโมงแล้วส่งออกอีกครั้ง หรือส่งออกเฉพาะการแก้ซับโดยไม่เปลี่ยน B-roll",
  },
};

/** The render route's in-band refusal copy for a flagged job it would otherwise charge. */
export const MCP_RENDER_NOT_FREE_MESSAGE =
  "งานนี้สั่งผ่านเอเจนต์และต้องไม่เสียโควต้า แต่การเรนเดอร์ครั้งนี้จะถูกคิดโควต้า ระบบจึงหยุดงานไว้โดยไม่ตัดโควต้า — เปิดลิงก์ editorUrl เพื่อส่งออกจากหน้าเว็บ";

export class McpRenderNotFreeError extends Error {
  readonly code = MCP_EXPORT_NOT_FREE_CODE;
  readonly reason: McpRenderNotFreeReason;
  readonly next: string;

  constructor(reason: McpRenderNotFreeReason) {
    super(NOT_FREE_COPY[reason].message);
    this.name = "McpRenderNotFreeError";
    this.reason = reason;
    this.next = NOT_FREE_COPY[reason].next;
  }
}

/**
 * Throws `McpRenderNotFreeError` unless every render the MCP chain is about to enqueue rides
 * an existing free path:
 *  - the Burn of `baseVideoUrl` — a ChargedClip for this user (`isBurnAlreadyPaid`);
 *  - with `rerender`, the B-roll re-render of a source whose preview config is
 *    `sourceConfig` — eligible for the `rerenderOf` skip (the orchestrator re-renders with
 *    `{ ...sourceConfig, bgVideos, keywordPopups: [] }`, so voice + duration are the source's)
 *    and a free slot left in the 10/user/hour budget (peeked, not consumed).
 */
export async function assertMcpRenderFree(input: {
  userId: string;
  baseVideoUrl: string | null | undefined;
  rerender?: { sourceConfig: Record<string, unknown> | null | undefined };
}): Promise<void> {
  if (!(await isBurnAlreadyPaid(input.userId, input.baseVideoUrl))) {
    throw new McpRenderNotFreeError("base_not_paid");
  }
  if (!input.rerender) return;
  const { sourceConfig } = input.rerender;
  const incomingConfig = sourceConfig && typeof sourceConfig === "object"
    ? { ...sourceConfig, keywordPopups: [] }
    : null;
  if (!rerenderSkipEligible({ sourceConfig, incomingConfig })) {
    throw new McpRenderNotFreeError("rerender_ineligible");
  }
  if (!rerenderSkipBudgetAvailable(input.userId)) {
    throw new McpRenderNotFreeError("rerender_budget_exhausted");
  }
}

/**
 * Does this (owner-scoped) VideoJob carry the MCP must-be-free flag? Read only when the render
 * route is about to CHARGE a service-actor render. Errors propagate: the route's outer catch
 * then fails the request before any reservation, which is the no-charge direction.
 */
export async function videoJobMustBeFree(userId: string, videoJobId: string): Promise<boolean> {
  const job = await prisma.videoJob.findFirst({
    where: { id: videoJobId, userId },
    select: { inputJson: true },
  });
  if (!job) return false;
  try {
    const input = JSON.parse(job.inputJson) as unknown;
    return !!input && typeof input === "object" && !Array.isArray(input)
      && (input as Record<string, unknown>).mcpMustBeFree === true;
  } catch {
    return false;
  }
}
