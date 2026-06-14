import { missingKeyError, missingAvatarError } from "@/lib/mcp/onboarding";

export type AvatarMode = "none" | "full" | "bookend" | "bookend-both";
export const AVATAR_LAYOUT = { scale: 2.02, offsetX: 0, offsetY: 0.13 } as const;

export function clampSecs(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(30, Math.max(1, n));
}

type AvatarArgs = { avatarMode?: string; avatarId?: string; avatarIntroSecs?: number; avatarTailSecs?: number };
type AvatarUser = { heygenKey: string | null; heygenAvatarId: string | null };
type ErrPayload = { error: string; message: string };

export type AvatarResolution =
  | { kind: "none" }
  | { kind: "error"; payload: ErrPayload }
  | { kind: "ok"; avatarMode: "full" | "bookend" | "bookend-both"; avatarId: string; introSecs: number; tailSecs: number };

export function resolveAvatarRequest(args: AvatarArgs, user: AvatarUser): AvatarResolution {
  const mode = args.avatarMode ?? "none";
  if (mode === "none") return { kind: "none" };
  if (mode !== "full" && mode !== "bookend" && mode !== "bookend-both")
    return { kind: "error", payload: { error: "bad_request", message: `avatarMode ไม่ถูกต้อง: ${mode}` } };
  if (!user.heygenKey) return { kind: "error", payload: missingKeyError("heygen") };
  const avatarId = args.avatarId ?? user.heygenAvatarId ?? "";
  if (!avatarId) return { kind: "error", payload: missingAvatarError() };
  return { kind: "ok", avatarMode: mode, avatarId, introSecs: clampSecs(args.avatarIntroSecs, 5), tailSecs: clampSecs(args.avatarTailSecs, 5) };
}
