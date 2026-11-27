/**
 * HERO-98: Post-export 1-click social video + caption handoff to app.heroaiengine.com
 * (/studio/video-handoff) and Weekly Content Series continuation helper.
 *
 * Pure module (zero server/DB imports) shared across Desktop PostPhase,
 * Mobile PostPhaseMobile, ExportedView, and the Videos Gallery.
 */

export const HERO_AI_SOCIAL_SCHEDULER_URL =
  "https://app.heroaiengine.com/?utm_source=hero_studio&utm_medium=post_export&utm_campaign=hero_98";

export const HERO_AI_VIDEO_HANDOFF_URL =
  "https://app.heroaiengine.com/studio/video-handoff";

export const HERO_STUDIO_PUBLIC_ORIGIN = "https://studio.heroaiengine.com";

const ALLOWED_HANDOFF_VIDEO_HOSTS = new Set([
  "studio.heroaiengine.com",
  "media.heroaiengine.com",
]);

const MAX_HANDOFF_URL_LENGTH = 3500;
const HARD_MAX_HANDOFF_URL_LENGTH = 3900;

export interface SocialPostCaptionInput {
  title?: string | null;
  script?: string | null;
  headline?: string | null;
}

export interface HeroSocialHandoffInput extends SocialPostCaptionInput {
  videoUrl?: string | null;
  durationSec?: number | null;
}

export interface SocialPostCaptionPack {
  hookLine: string;
  bodySummary: string;
  hashtags: string[];
  captionText: string;
}

function cleanSingleLine(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

function safeSliceUtf16(value: string, maxUnits: number): string {
  if (maxUnits <= 0 || !value) return "";
  const sliced = value.length <= maxUnits ? value : value.slice(0, maxUnits);
  return sliced.replace(/[\uD800-\uDBFF]$/, "").trim();
}

/**
 * Resolves a Studio render path or media URL into an allowlisted HTTPS URL accepted
 * by app.heroaiengine.com/studio/video-handoff (studio.heroaiengine.com or
 * media.heroaiengine.com, /api/renders/..., /renders/..., or .mp4/.mov).
 * Returns null when missing or untrusted so callers safely fall back to HERO_AI_SOCIAL_SCHEDULER_URL.
 */
export function resolveStudioHandoffVideoUrl(
  rawVideoUrl: string | null | undefined,
): string | null {
  const trimmed = (rawVideoUrl ?? "").trim();
  if (!trimmed || trimmed.startsWith("//")) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, HERO_STUDIO_PUBLIC_ORIGIN);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (!ALLOWED_HANDOFF_VIDEO_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const pathname = parsed.pathname;
  if (pathname.includes("..")) return null;

  const isAllowedPath =
    (pathname.startsWith("/api/renders/") && pathname.length > "/api/renders/".length)
    || (pathname.startsWith("/renders/") && pathname.length > "/renders/".length)
    || /\.(mp4|mov)$/i.test(pathname);
  if (!isAllowedPath) return null;

  parsed.hash = "";
  return parsed.toString();
}

export function buildSocialPostCaptionPack(
  input: SocialPostCaptionInput,
): SocialPostCaptionPack {
  const rawLines = (input.script ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  const explicitHeadline = cleanSingleLine(input.headline);
  const cleanTitle = cleanSingleLine(input.title);
  const hookLine =
    explicitHeadline
    || rawLines[0]
    || (cleanTitle && cleanTitle !== "โปรเจกต์ไม่มีชื่อ" && cleanTitle !== "New Project" ? cleanTitle : "")
    || "คลิปใหม่พร้อมลงทุกช่องทาง";

  const bodyLines = rawLines
    .filter((line) => line !== hookLine)
    .slice(0, 3);
  const bodySummary = bodyLines.join("\n");

  const hashtags = ["#คลิปสั้น", "#ความรู้ดีๆ", "#ครีเอเตอร์", "#HeroAI"];
  const parts = [
    hookLine,
    ...(bodySummary ? [bodySummary] : []),
    hashtags.join(" "),
  ];

  return {
    hookLine,
    bodySummary,
    hashtags,
    captionText: parts.join("\n\n"),
  };
}

export function buildHeroSocialHandoffUrl(input: HeroSocialHandoffInput): string {
  const resolvedVideoUrl = resolveStudioHandoffVideoUrl(input.videoUrl);
  if (!resolvedVideoUrl) {
    return HERO_AI_SOCIAL_SCHEDULER_URL;
  }

  const pack = buildSocialPostCaptionPack(input);
  const headline = safeSliceUtf16(pack.hookLine, 120);
  const rawTitle = cleanSingleLine(input.title);
  const title =
    rawTitle && rawTitle !== "โปรเจกต์ไม่มีชื่อ" && rawTitle !== "New Project"
      ? safeSliceUtf16(rawTitle, 120)
      : "";
  const durationSec =
    typeof input.durationSec === "number"
    && Number.isFinite(input.durationSec)
    && input.durationSec > 0
      ? Math.round(input.durationSec)
      : 0;

  const buildCandidate = (captionValue: string): string => {
    const url = new URL(HERO_AI_VIDEO_HANDOFF_URL);
    url.searchParams.set("videoUrl", resolvedVideoUrl);
    if (headline) url.searchParams.set("headline", headline);
    if (title) url.searchParams.set("title", title);
    if (captionValue) url.searchParams.set("caption", captionValue);
    if (durationSec > 0) url.searchParams.set("durationSec", String(durationSec));
    return url.toString();
  };

  let captionLimit = 450;
  let candidate = buildCandidate(safeSliceUtf16(pack.captionText, captionLimit));
  while (candidate.length > MAX_HANDOFF_URL_LENGTH && captionLimit > 0) {
    captionLimit = Math.max(0, captionLimit - 40);
    candidate = buildCandidate(safeSliceUtf16(pack.captionText, captionLimit));
  }

  if (candidate.length > HARD_MAX_HANDOFF_URL_LENGTH) {
    return HERO_AI_SOCIAL_SCHEDULER_URL;
  }
  return candidate;
}

export function buildWeeklySeriesHref(input: SocialPostCaptionInput): string {
  const pack = buildSocialPostCaptionPack(input);
  const seedBase = pack.hookLine.slice(0, 120);
  const nextEpisodePrompt = `ภาคต่อซีรีส์ (EP ถัดไป) ต่อยอดจากประเด็น: ${seedBase}`;
  return `/hero-script?seriesSeed=${encodeURIComponent(nextEpisodePrompt)}`;
}
