import { NextResponse } from "next/server";

export function desktopJson(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json({ code, message, ...extra }, { status });
}
