/**
 * HERO-98: Post-export social scheduling handoff to app.heroaiengine.com
 * and Weekly Content Series continuation helper.
 *
 * Pure module (zero server/DB imports) shared across Desktop PostPhase,
 * Mobile PostPhaseMobile, ExportedView, and the Videos Gallery.
 */

export const HERO_AI_SOCIAL_SCHEDULER_URL =
  "https://app.heroaiengine.com/?utm_source=hero_studio&utm_medium=post_export&utm_campaign=hero_98";

export interface SocialPostCaptionInput {
  title?: string | null;
  script?: string | null;
  headline?: string | null;
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

export function buildWeeklySeriesHref(input: SocialPostCaptionInput): string {
  const pack = buildSocialPostCaptionPack(input);
  const seedBase = pack.hookLine.slice(0, 120);
  const nextEpisodePrompt = `ภาคต่อซีรีส์ (EP ถัดไป) ต่อยอดจากประเด็น: ${seedBase}`;
  return `/hero-script?seriesSeed=${encodeURIComponent(nextEpisodePrompt)}`;
}
