/**
 * Central API error handler
 *
 * - Returns a SHORT, human-readable message to the user (Thai)
 * - Sends FULL technical detail to all admins via notification
 * - Logs to console for server logs
 *
 * User notification is OPT-IN only (notifyUser: true) — only use for
 * pipeline steps that directly affect the user's video/content output.
 * Never set for background/settings/config routes.
 */

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { decideAdminErrorNotify } from "@/lib/admin-error-notify";
import { notifyAdmins, createNotification } from "@/lib/notifications";
import { scrubSecrets } from "@/lib/scrub-secrets";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";

export { scrubSecrets };

interface ErrorContext {
  /** Where the error happened — shown in admin notification title */
  route: string;
  /** The caught error object */
  error: unknown;
  /** Explicitly notify the calling user via bell notification (default: false) */
  notifyUser?: boolean;
  /** Optional: user ID override (if not provided, inferred from session when notifyUser=true) */
  userId?: string;
  /** Optional: user-facing message override (Thai) */
  userMessage?: string;
  /** Optional: extra context to include in admin notification */
  context?: Record<string, unknown>;
  /** HTTP status code to return (default 500) */
  status?: number;
}

/** Scrub the message/stack of a caught error, preserving shape for logging. */
function scrubError(error: unknown): { name: string; message: string; stack?: string } | string {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: scrubSecrets(error.message),
      stack: error.stack ? scrubSecrets(error.stack) : undefined,
    };
  }
  try {
    return scrubSecrets(JSON.stringify(error));
  } catch {
    return scrubSecrets(String(error));
  }
}

/**
 * User-friendly message for common error patterns, paired with `detail` — the scrubbed
 * original cause (≤300 chars) — so a caller (an admin, a support ticket, a future UI) can
 * see WHAT actually broke without the bare Thai fallback being the only signal. `detail`
 * is always derived from the real error, independent of any `userMessage` override.
 */
export function friendlyMessage(error: unknown): { message: string; detail: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const detail = scrubSecrets(msg).slice(0, 300);

  if (/unauthorized|401/i.test(msg)) return { message: "ไม่มีสิทธิ์เข้าถึง กรุณาเข้าสู่ระบบใหม่", detail };
  if (/rate.?limit|429|quota/i.test(msg)) return { message: "ระบบ AI ถูกใช้งานหนักเกินไป กรุณาลองใหม่ในอีกสักครู่", detail };
  if (/api.?key|invalid.?key/i.test(msg)) return { message: "API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings", detail };
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) return { message: "การเชื่อมต่อหมดเวลา กรุณาลองใหม่อีกครั้ง", detail };
  if (/not.?found|ENOENT/i.test(msg)) return { message: "ไม่พบข้อมูลที่ต้องการ", detail };
  if (/network|ECONNREFUSED|fetch/i.test(msg)) return { message: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่", detail };
  if (/render|remotion/i.test(msg)) return { message: "เกิดข้อผิดพลาดในการสร้างวิดีโอ กรุณาลองใหม่", detail };
  if (/heygen/i.test(msg)) return { message: "เกิดข้อผิดพลาดจากระบบ Avatar กรุณาลองใหม่", detail };
  if (/elevenlabs/i.test(msg)) return { message: "เกิดข้อผิดพลาดจากระบบเสียง กรุณาลองใหม่", detail };
  if (/gemini/i.test(msg)) return { message: "เกิดข้อผิดพลาดจากระบบ AI กรุณาลองใหม่", detail };
  if (/prisma|database|sqlite/i.test(msg)) return { message: "เกิดข้อผิดพลาดในฐานข้อมูล กรุณาลองใหม่", detail };

  return { message: GENERIC_ERROR_COPY, detail };
}

function buildAdminBody(
  route: string,
  error: unknown,
  userId?: string,
  context?: Record<string, unknown>,
  detail?: string,
): string {
  const lines: string[] = [];
  lines.push(`🔴 Route: ${route}`);
  lines.push(`🕐 Time: ${new Date().toISOString()}`);
  if (userId) lines.push(`👤 User: ${userId}`);
  if (error instanceof Error) {
    lines.push(`❌ Error: ${error.name}: ${scrubSecrets(error.message)}`);
    if (error.stack) {
      const stackLines = scrubSecrets(error.stack.split("\n").slice(0, 6).join(" | "));
      lines.push(`📋 Stack: ${stackLines}`);
    }
  } else {
    lines.push(`❌ Error: ${scrubSecrets(JSON.stringify(error))}`);
  }
  // `detail` (friendlyMessage's scrubbed original cause, ≤300 chars) is admin/log-only —
  // NEVER returned on the public JSON envelope (security review R30). This is its one
  // consumer, so an admin can still see the real cause even when `userMessage` overrides
  // the customer-facing text above.
  if (detail) lines.push(`📝 Detail: ${detail}`);
  if (context && Object.keys(context).length > 0) {
    try {
      lines.push(`📦 Context: ${scrubSecrets(JSON.stringify(context, null, 0).slice(0, 500))}`);
    } catch {
      lines.push(`📦 Context: [unserializable]`);
    }
  }
  return lines.join("\n");
}

export function apiError({
  route,
  error,
  notifyUser = false,
  userId,
  userMessage,
  context,
  status = 500,
}: ErrorContext): NextResponse {
  // 1. Log to console (scrubbed — never let a leaked ?key=/token= reach PM2 logs)
  console.error(`[API Error] ${route}:`, scrubError(error));

  const friendly = friendlyMessage(error);
  const message = userMessage ?? friendly.message;
  const detail = friendly.detail;

  // 2. Notify admins + optionally the user — fire-and-forget
  const notify = async () => {
    let uid = userId;
    if (!uid && notifyUser) {
      try {
        const actor = await getCurrentUser();
        uid = actor?.id;
      } catch { /* ignore */ }
    }

    // SQLite timeouts must not persist ERROR_SYSTEM; other routes write once per 5 minutes.
    const decision = decideAdminErrorNotify({ error, route });
    if (decision.action === "write") {
      const suppressedNote = decision.suppressed > 0
        ? `\n📉 Suppressed ${decision.suppressed} similar ERROR_SYSTEM for this route since last notify`
        : "";
      await notifyAdmins({
        type: "ERROR_SYSTEM",
        title: `⚠️ Error: ${route}`,
        body: buildAdminBody(route, error, uid, context, detail) + suppressedNote,
      });
    } else {
      const why = decision.action === "skip_capacity" ? "capacity" : `rate-limit x${decision.suppressed}`;
      console.error(`[API Error] skip ERROR_SYSTEM (${why}) ${route}`);
    }

    // Only notify user when explicitly opted in (pipeline steps)
    if (notifyUser && uid) {
      await createNotification({
        userId: uid,
        type: "VIDEO_FAILED",
        title: "เกิดข้อผิดพลาด",
        body: message,
      });
    }
  };

  notify().catch(() => {});

  return NextResponse.json({ error: message }, { status });
}

/** Shorthand for user-facing validation errors (no admin notify needed) */
export function validationError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
