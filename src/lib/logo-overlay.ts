export const LOGO_POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type LogoPosition = (typeof LOGO_POSITIONS)[number];

export type LogoOverlayConfig = {
  enabled: boolean;
  assetId: string;
  position: LogoPosition;
  sizePct: number;
  opacity: number;
};

export type LogoIntrinsicSize = { width: number; height: number };
export type LogoFrame = { left: number; top: number; width: number; height: number };
export type BrandAssetView = {
  id: string;
  displayName: string;
  mimeType: "image/webp";
  sizeBytes: number;
  width: number;
  height: number;
  imageUrl: string;
};

export const DEFAULT_LOGO_POSITION: LogoPosition = "top-right";
export const DEFAULT_LOGO_SIZE_PCT = 18;
export const DEFAULT_LOGO_OPACITY = 0.9;
export const MIN_LOGO_SIZE_PCT = 8;
export const MAX_LOGO_SIZE_PCT = 35;
export const MIN_LOGO_OPACITY = 0.2;
export const MAX_LOGO_OPACITY = 1;

const DEFAULT_SAFE_INSET_PCT = 4;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finiteOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isLogoPosition = (value: unknown): value is LogoPosition =>
  typeof value === "string" && LOGO_POSITIONS.some((position) => position === value);

export function normalizeLogoOverlayConfig(value: unknown): LogoOverlayConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  const assetId = typeof candidate.assetId === "string" ? candidate.assetId.trim() : "";
  if (!assetId) return null;

  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    assetId,
    position: isLogoPosition(candidate.position)
      ? candidate.position
      : DEFAULT_LOGO_POSITION,
    sizePct: clamp(
      finiteOr(candidate.sizePct, DEFAULT_LOGO_SIZE_PCT),
      MIN_LOGO_SIZE_PCT,
      MAX_LOGO_SIZE_PCT,
    ),
    opacity: clamp(
      finiteOr(candidate.opacity, DEFAULT_LOGO_OPACITY),
      MIN_LOGO_OPACITY,
      MAX_LOGO_OPACITY,
    ),
  };
}

export function logoOverlayForNewProject(input: {
  hasExistingDraft: boolean;
  accountDefault: LogoOverlayConfig | null;
}): LogoOverlayConfig | undefined {
  return input.hasExistingDraft || !input.accountDefault
    ? undefined
    : { ...input.accountDefault };
}

export function logoOverlayFrame(input: {
  position: LogoPosition;
  sizePct: number;
  intrinsic: LogoIntrinsicSize;
  frameWidth: number;
  frameHeight: number;
  safeInsetPct?: number;
}): LogoFrame {
  const frameWidth = Math.max(0, finiteOr(input.frameWidth, 0));
  const frameHeight = Math.max(0, finiteOr(input.frameHeight, 0));
  const safeInsetPct = Math.max(
    0,
    finiteOr(input.safeInsetPct, DEFAULT_SAFE_INSET_PCT),
  );
  const sizePct = clamp(
    finiteOr(input.sizePct, DEFAULT_LOGO_SIZE_PCT),
    MIN_LOGO_SIZE_PCT,
    MAX_LOGO_SIZE_PCT,
  );
  const intrinsicWidth = finiteOr(input.intrinsic.width, 0);
  const intrinsicHeight = finiteOr(input.intrinsic.height, 0);
  const aspectRatio =
    intrinsicWidth > 0 && intrinsicHeight > 0
      ? intrinsicHeight / intrinsicWidth
      : 1;

  const inset = frameWidth * (safeInsetPct / 100);
  let logoWidth = frameWidth * (sizePct / 100);
  let logoHeight = logoWidth * aspectRatio;
  const availableHeight = Math.max(0, frameHeight - inset * 2);

  if (logoHeight > availableHeight) {
    const scale = availableHeight / logoHeight;
    logoWidth *= scale;
    logoHeight *= scale;
  }

  const { position } = input;
  const x = position.endsWith("left") ? inset
    : position.endsWith("right") ? frameWidth - inset - logoWidth
    : (frameWidth - logoWidth) / 2;
  const y = position.startsWith("top") ? inset
    : position.startsWith("bottom") ? frameHeight - inset - logoHeight
    : (frameHeight - logoHeight) / 2;

  return { left: x, top: y, width: logoWidth, height: logoHeight };
}
