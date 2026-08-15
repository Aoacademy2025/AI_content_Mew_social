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
import { notifyAdmins, createNotification } from "@/lib/notifications";

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

/**
 * Redact secrets (API keys/tokens) that may have leaked into an error message or
 * stack trace — e.g. an outbound `fetch` to a third-party API whose URL embeds
 * `?key=<secret>` shows up verbatim in the thrown error's `.message`. This runs
 * before anything is written to PM2 console logs or the DB-backed admin
 * notification, so secrets never land in either place.
 */
export function scrubSecrets(input: string): string {
  if (!input) return input;
  return input
    // query-string style: key=, api_key=, apikey=, access_key=, token=
    .replace(/([?&](?:key|api[_-]?key|access[_-]?key|token)=)[^&\s"'<>]+/gi, "$1<redacted>")
    // Google/Gemini style API keys (AIza...) appearing anywhere, incl. headers
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<redacted>")
    // x-goog-api-key header value if serialized into a message/stack
    .replace(/(x-goog-api-key["'\s:=]+)[A-Za-z0-9_-]{10,}/gi, "$1<redacted>")
    // Authorization: Bearer <token>
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/gi, "$1<redacted>")
    // OpenRouter style API keys (sk-or-...) appearing anywhere — a bare key
    // without the "Bearer " prefix would slip past the rule above.
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "<redacted>");
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

/** User-friendly messages for common error patterns */
function friendlyMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);

  if (/unauthorized|401/i.test(msg)) return "ไม่มีสิทธิ์เข้าถึง กรุณาเข้าสู่ระบบใหม่";
  if (/rate.?limit|429|quota/i.test(msg)) return "ระบบ AI ถูกใช้งานหนักเกินไป กรุณาลองใหม่ในอีกสักครู่";
  if (/api.?key|invalid.?key/i.test(msg)) return "API Key ไม่ถูกต้อง กรุณาตรวจสอบใน Settings";
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) return "การเชื่อมต่อหมดเวลา กรุณาลองใหม่อีกครั้ง";
  if (/not.?found|ENOENT/i.test(msg)) return "ไม่พบข้อมูลที่ต้องการ";
  if (/network|ECONNREFUSED|fetch/i.test(msg)) return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่";
  if (/render|remotion/i.test(msg)) return "เกิดข้อผิดพลาดในการสร้างวิดีโอ กรุณาลองใหม่";
  if (/heygen/i.test(msg)) return "เกิดข้อผิดพลาดจากระบบ Avatar กรุณาลองใหม่";
  if (/elevenlabs/i.test(msg)) return "เกิดข้อผิดพลาดจากระบบเสียง กรุณาลองใหม่";
  if (/gemini/i.test(msg)) return "เกิดข้อผิดพลาดจากระบบ AI กรุณาลองใหม่";
  if (/prisma|database|sqlite/i.test(msg)) return "เกิดข้อผิดพลาดในฐานข้อมูล กรุณาลองใหม่";

  return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
}

function buildAdminBody(route: string, error: unknown, userId?: string, context?: Record<string, unknown>): string {
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

  const message = userMessage ?? friendlyMessage(error);

  // 2. Notify admins + optionally the user — fire-and-forget
  const notify = async () => {
    let uid = userId;
    if (!uid && notifyUser) {
      try {
        const actor = await getCurrentUser();
        uid = actor?.id;
      } catch { /* ignore */ }
    }

    // Always notify admins
    await notifyAdmins({
      type: "ERROR_SYSTEM",
      title: `⚠️ Error: ${route}`,
      body: buildAdminBody(route, error, uid, context),
    });

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
