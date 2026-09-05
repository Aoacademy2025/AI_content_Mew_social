import { NextResponse } from "next/server";

import {
  buildLineRetryKey,
  buildSentryLineAlert,
  sendLinePush,
  timingSafeTextEqual,
  verifySentryServiceHookSignature,
} from "@/lib/sentry-line-alert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  if (process.env.SENTRY_LINE_ALERTS_ENABLED !== "1") {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  const hookSecret = process.env.SENTRY_SERVICE_HOOK_SECRET?.trim() ?? "";
  const hookId = process.env.SENTRY_SERVICE_HOOK_ID?.trim() ?? "";
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? "";
  const targetId = process.env.LINE_TARGET_USER_ID?.trim() ?? "";
  if (
    !/^[a-f0-9]{64}$/i.test(hookSecret) ||
    !/^[a-f0-9]{32}$/i.test(hookId) ||
    accessToken.length < 32 ||
    !/^[UCR][a-f0-9]{32}$/i.test(targetId)
  ) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }

  const signature = request.headers.get("x-servicehook-signature");
  const requestHookId = request.headers.get("x-servicehook-guid");
  if (
    !verifySentryServiceHookSignature(rawBody, signature, hookSecret) ||
    !timingSafeTextEqual(requestHookId, hookId)
  ) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const alert = buildSentryLineAlert(payload);
  if (!alert) {
    return NextResponse.json({ ok: true, delivered: false });
  }

  const retryKey = buildLineRetryKey(hookId, alert.eventId);
  try {
    const delivered = await sendLinePush({
      accessToken,
      targetId,
      text: alert.text,
      retryKey,
    });
    if (!delivered) {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ ok: false }, { status: 502 });
  }

  return NextResponse.json({ ok: true, delivered: true });
}
