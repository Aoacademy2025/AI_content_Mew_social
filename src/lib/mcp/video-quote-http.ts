import { isDatabaseBusyError } from "@/lib/prisma-errors";
import { RenderDeployDrainError, RENDER_MAINTENANCE_CUSTOMER_MESSAGE } from "@/lib/render-deploy-drain";
import { decideVideoQuote, getVideoQuote } from "./video-quote.server";
import { quoteFailure, type VideoQuoteReply } from "./video-quote";

type Context = { params: Promise<{ quoteId: string }> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
function reply(result: VideoQuoteReply) {
  return json(result, "error" in result ? result.code === "quote_not_found" ? 404 : (result.code === "database_busy" || result.code === "render_maintenance") ? 503 : 409 : 200);
}
function busyReply() {
  return reply(quoteFailure("database_busy", "ระบบมีงานเข้าพร้อมกันเยอะ คำสั่งนี้ยังไม่สำเร็จ", "รอสักครู่แล้วกดยืนยันอีกครั้ง"));
}

/** Browser auth is supplied by the route's direct Clerk session adapter, never MCP auth.
 * The same HTTP handlers are exercised by the disposable fixture harness. */
export function createQuoteHttpHandlers(browserOwner: () => Promise<string | null>) {
  async function owner(request: Request) {
    // Even a valid Studio session cannot turn an agent's bearer request into approval.
    if (["authorization", "x-heroai-service-secret", "x-heroai-act-as"].some((name) => request.headers.has(name))) return null;
    return browserOwner();
  }
  return {
    async GET(request: Request, context: Context) {
      try {
        const userId = await owner(request);
        if (!userId) return json(quoteFailure("unauthorized", "กรุณาเข้าสู่ระบบ Studio", "เปิด confirmationUrl แล้วเข้าสู่ระบบบัญชีเจ้าของงาน"), 401);
        return reply(await getVideoQuote(userId, (await context.params).quoteId));
      } catch (err) {
        if (isDatabaseBusyError(err)) return busyReply();
        throw err;
      }
    },
    async POST(request: Request, context: Context) {
      try {
        const userId = await owner(request);
        if (!userId) return json(quoteFailure("unauthorized", "กรุณาเข้าสู่ระบบ Studio", "เปิด confirmationUrl แล้วเข้าสู่ระบบบัญชีเจ้าของงาน"), 401);
        const expectedOrigin = new URL(process.env.MCP_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || request.url).origin;
        if (request.headers.get("origin") !== expectedOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
          return json(quoteFailure("same_origin_required", "กรุณายืนยันจากหน้า Studio โดยตรง", "เปิด confirmationUrl ในเบราว์เซอร์แล้วกดยืนยัน"), 403);
        }
        if (!request.headers.get("content-type")?.startsWith("application/json")) return json(quoteFailure("invalid_input", "รูปแบบคำขอไม่ถูกต้อง"), 400);
        let action: unknown;
        let startNow = false;
        try {
          const text = await request.text();
          if (text.length > 1024) throw new Error("too_large");
          const parsed = JSON.parse(text) as { action?: unknown; startNow?: unknown };
          action = parsed.action;
          startNow = parsed.startNow === true;
        } catch { return json(quoteFailure("invalid_input", "รูปแบบคำขอไม่ถูกต้อง"), 400); }
        if (action !== "approve" && action !== "reject") return json(quoteFailure("invalid_input", "เลือกยืนยันหรือปฏิเสธใบยืนยัน"), 400);
        const { quoteId } = await context.params;
        const decided = await decideVideoQuote(userId, quoteId, action);
        if ("error" in decided || action !== "approve" || !startNow) return reply(decided);
        const { consumeVideoQuote } = await import("./video-budget.server");
        const consumed = await consumeVideoQuote(userId, quoteId);
        if ("error" in consumed) return reply(consumed);
        return reply(await getVideoQuote(userId, quoteId));
      } catch (err) {
        if (err instanceof RenderDeployDrainError) {
          return reply(quoteFailure("render_maintenance", RENDER_MAINTENANCE_CUSTOMER_MESSAGE, "รอสักครู่แล้วกดยืนยันอีกครั้ง"));
        }
        if (isDatabaseBusyError(err)) return busyReply();
        throw err;
      }
    },
  };
}
