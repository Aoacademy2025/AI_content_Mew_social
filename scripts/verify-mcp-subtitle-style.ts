// verify-mcp-subtitle-style.ts — MCP subtitle style, Brand Subtitle Style and options (T4).
//
// Plan: docs/plans/2026-10-01-mcp-upgrade-p0-p1.md (T4). Resolution order (Global
// Constraints): explicit MCP args → Brand Subtitle Style → DEFAULT_V2_SUB. Mode and
// position resolve per field — an explicit subtitleMode/subtitlePosition always beats
// whatever the rest of the design comes from. A brand affects only the subtitle look;
// voice, visuals and logo are never touched. A foreign or inactive brandProfileId
// refuses identically — never revealing whether the id exists at all.
//
// Run: node --conditions=react-server --import tsx scripts/verify-mcp-subtitle-style.ts

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  v2SubConfigToHeroDesign,
  brandSubtitleStyleToV2SubConfig,
  resolveMcpSubtitleDesign,
  resolvedMcpSubtitleDesignFromInput,
  maxCardCharsFor,
  brandSubtitleStyleMissingWarning,
  BRAND_SUBTITLE_STYLE_MISSING_WARNING,
} from "../src/lib/mcp/orchestrator-steps";
import { DEFAULT_V2_SUB, V2_QUICK_STYLES } from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import type { SubtitleStylePresetConfig } from "../src/lib/editor-style-preset-contract";
import { getVideoOptions } from "../src/lib/mcp/video-options";
import type { PipelineCaller } from "../src/lib/mcp/pipeline-client";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

// ── A. pure converters ───────────────────────────────────────────────────────────────
console.log("A) v2SubConfigToHeroDesign / brandSubtitleStyleToV2SubConfig");
{
  const design = v2SubConfigToHeroDesign(DEFAULT_V2_SUB);
  check("fontFamily passes through unquoted (matches the web editor's own burn)", design.fontFamily === "Kanit");
  check("positionTopPercent = verticalPos", design.positionTopPercent === DEFAULT_V2_SUB.verticalPos);
  check("fontSize/color/accentColor map 1:1", design.fontSize === DEFAULT_V2_SUB.fontSize
    && design.color === DEFAULT_V2_SUB.textColor && design.accentColor === DEFAULT_V2_SUB.accentColor);
  check("stylePreset/textEffect are identity casts (shared literal sets)",
    design.stylePreset === DEFAULT_V2_SUB.preset && design.textEffect === DEFAULT_V2_SUB.effect);
  check("fontWeight uses the explicit value when present", design.fontWeight === DEFAULT_V2_SUB.fontWeight);
  check("shadow/outline/outlineSize pass through", design.shadow === DEFAULT_V2_SUB.shadow
    && design.outline === DEFAULT_V2_SUB.outline && design.outlineSize === DEFAULT_V2_SUB.outlineSize);

  const noWeight = v2SubConfigToHeroDesign({ ...DEFAULT_V2_SUB, fontWeight: undefined, bold: true });
  check("fontWeight falls back to bold ? 900 : 400 when absent", noWeight.fontWeight === 900);
  const noWeightThin = v2SubConfigToHeroDesign({ ...DEFAULT_V2_SUB, fontWeight: undefined, bold: false });
  check("fontWeight falls back to 400 when absent and not bold", noWeightThin.fontWeight === 400);

  const brandStyle: SubtitleStylePresetConfig = {
    preset: "shadow", effect: "fade", cardLen: "2", fontFamily: "Noto Sans Thai", bold: false,
    fontWeight: 400, fontSize: 64, textColor: "#000000", accentColor: "#00FF00",
    shadow: true, outline: false, outlineSize: 2, verticalPos: 30,
  };
  const asV2 = brandSubtitleStyleToV2SubConfig(brandStyle);
  check("brandSubtitleStyleToV2SubConfig drops cardLen, keeps the rest",
    !("cardLen" in asV2) && asV2.preset === "shadow" && asV2.fontSize === 64 && asV2.verticalPos === 30);
}

// ── B. resolveMcpSubtitleDesign: explicit args → Brand Subtitle Style → DEFAULT_V2_SUB ──
console.log("B) resolveMcpSubtitleDesign resolution order");
{
  const brandStyle: SubtitleStylePresetConfig = {
    preset: "shadow", effect: "fade", cardLen: "2", fontFamily: "Noto Sans Thai", bold: false,
    fontWeight: 400, fontSize: 64, textColor: "#000000", accentColor: "#00FF00",
    shadow: true, outline: false, outlineSize: 2, verticalPos: 30,
  };

  const noArgsNoBrand = resolveMcpSubtitleDesign({}, null);
  check("no args, no brand → DEFAULT_V2_SUB, cardLen sentence",
    JSON.stringify(noArgsNoBrand.design) === JSON.stringify(DEFAULT_V2_SUB) && noArgsNoBrand.cardLen === "sentence");

  const brandOnly = resolveMcpSubtitleDesign({}, brandStyle);
  check("brand only (no explicit args) → brand's design + brand's cardLen",
    brandOnly.design.fontSize === 64 && brandOnly.design.verticalPos === 30
    && brandOnly.design.preset === "shadow" && brandOnly.cardLen === "2");

  const sizeOverride = resolveMcpSubtitleDesign({ subtitleSize: 100 }, brandStyle);
  check("explicit subtitleSize overrides the brand's fontSize, leaves the rest of the brand's look",
    sizeOverride.design.fontSize === 100 && sizeOverride.design.verticalPos === 30 && sizeOverride.design.preset === "shadow");

  const colorOverride = resolveMcpSubtitleDesign({ subtitleColor: "#111111", subtitleAccentColor: "#222222" }, brandStyle);
  check("explicit subtitleColor/subtitleAccentColor override the brand's colors only",
    colorOverride.design.textColor === "#111111" && colorOverride.design.accentColor === "#222222"
    && colorOverride.design.fontSize === 64);

  const styleOverride = resolveMcpSubtitleDesign({ subtitleStyle: "viral" }, brandStyle);
  const viralQuick = V2_QUICK_STYLES.find((s) => s.key === "viral")!;
  check("explicit subtitleStyle overrides preset+effect only, leaves the brand's size/colors",
    styleOverride.design.preset === viralQuick.preset && styleOverride.design.effect === viralQuick.effect
    && styleOverride.design.fontSize === 64 && styleOverride.design.textColor === "#000000");

  const positionOverride = resolveMcpSubtitleDesign({ subtitlePosition: "top" }, brandStyle);
  check("explicit subtitlePosition overrides verticalPos via POSITION_TOP_PERCENT, leaves the rest",
    positionOverride.design.verticalPos === 12 && positionOverride.design.fontSize === 64);
  const positionBottomNoBrand = resolveMcpSubtitleDesign({ subtitlePosition: "bottom" }, null);
  check("subtitlePosition bottom/middle map correctly with no brand",
    positionBottomNoBrand.design.verticalPos === 78
    && resolveMcpSubtitleDesign({ subtitlePosition: "middle" }, null).design.verticalPos === 45);

  const modeOverride = resolveMcpSubtitleDesign({ subtitleMode: "3" }, brandStyle);
  check("explicit subtitleMode overrides the brand's cardLen", modeOverride.cardLen === "3");
  check("no explicit mode keeps the brand's cardLen", resolveMcpSubtitleDesign({}, brandStyle).cardLen === "2");
  check("no explicit mode and no brand falls back to sentence", resolveMcpSubtitleDesign({}, null).cardLen === "sentence");

  const fullExplicitNoBrand = resolveMcpSubtitleDesign({
    subtitleSize: 120, subtitleStyle: "outline", subtitleColor: "#ABCDEF", subtitleAccentColor: "#FEDCBA",
    subtitlePosition: "top", subtitleMode: "1",
  }, null);
  const outlineQuick = V2_QUICK_STYLES.find((s) => s.key === "outline")!;
  check("fully explicit args with no brand resolve purely from args over DEFAULT_V2_SUB",
    fullExplicitNoBrand.design.fontSize === 120 && fullExplicitNoBrand.design.preset === outlineQuick.preset
    && fullExplicitNoBrand.design.effect === outlineQuick.effect && fullExplicitNoBrand.design.textColor === "#ABCDEF"
    && fullExplicitNoBrand.design.accentColor === "#FEDCBA" && fullExplicitNoBrand.design.verticalPos === 12
    && fullExplicitNoBrand.cardLen === "1");

  const unknownStyleId = resolveMcpSubtitleDesign({ subtitleStyle: "not-a-real-style" }, null);
  check("an unrecognized subtitleStyle id is ignored (schema already rejects it; defensive here too)",
    unknownStyleId.design.preset === DEFAULT_V2_SUB.preset && unknownStyleId.design.effect === DEFAULT_V2_SUB.effect);
}

// ── C. resolvedMcpSubtitleDesignFromInput: read-back for a persisted job ───────────────
console.log("C) resolvedMcpSubtitleDesignFromInput read-back (T3's QA helper)");
{
  const customDesign = { ...DEFAULT_V2_SUB, fontSize: 64 };
  const fromPersisted = resolvedMcpSubtitleDesignFromInput({ subtitleDesign: customDesign, subtitleCardLen: "2" });
  check("reads back a T4 job's persisted design + cardLen",
    fromPersisted.design.fontSize === 64 && fromPersisted.cardLen === "2");

  const preT4Job = resolvedMcpSubtitleDesignFromInput({ subtitleMode: "3" });
  check("a pre-T4 job (no subtitleDesign) falls back to DEFAULT_V2_SUB + its own subtitleMode",
    JSON.stringify(preT4Job.design) === JSON.stringify(DEFAULT_V2_SUB) && preT4Job.cardLen === "3");

  const emptyJob = resolvedMcpSubtitleDesignFromInput({});
  check("a job with neither field falls back to DEFAULT_V2_SUB + sentence",
    JSON.stringify(emptyJob.design) === JSON.stringify(DEFAULT_V2_SUB) && emptyJob.cardLen === "sentence");
}

// ── C2. brandSubtitleStyleMissingWarning (T7 Part B): fires only when a brand WAS
// resolved (explicit id or single-brand auto-pick) but has no usable subtitle style ──────
console.log("C2) brandSubtitleStyleMissingWarning (T7 Part B session ruling)");
{
  check("no brand looked up at all (no id, no/zero active brands) → no warning",
    brandSubtitleStyleMissingWarning(null) === null);
  check("a brand lookup that refused (foreign/archived/frozen/unpublished) → no warning (brand_not_found already returned)",
    brandSubtitleStyleMissingWarning({ found: false }) === null);
  check("a resolved brand with a usable subtitle style → no warning",
    brandSubtitleStyleMissingWarning({
      found: true,
      style: { preset: "shadow", effect: "fade", cardLen: "2", fontFamily: "Noto Sans Thai", bold: false,
        fontWeight: 400, fontSize: 64, textColor: "#000000", accentColor: "#00FF00",
        shadow: true, outline: false, outlineSize: 2, verticalPos: 30 },
    }) === null);
  check("a resolved brand with no usable subtitle style (style: null) → fires the exact warning text",
    brandSubtitleStyleMissingWarning({ found: true, style: null }) === BRAND_SUBTITLE_STYLE_MISSING_WARNING);
  check("the warning text matches the plan's session ruling exactly",
    BRAND_SUBTITLE_STYLE_MISSING_WARNING === "แบรนด์นี้ยังไม่ได้ตั้งสไตล์ซับ — ใช้สไตล์ซับค่าเริ่มต้นแทน");
}

// ── D. get_video_options.subtitle shape (no DB — brands are passed in) ─────────────────
async function verifyVideoOptionsSubtitleShape() {
  console.log("D) get_video_options.subtitle shape");
  const mockCaller: PipelineCaller = {
    async get<T>(path: string): Promise<T> {
      if (path === "/api/music") return { tracks: [], userTracks: [] } as T;
      throw new Error("unexpected " + path);
    },
    post: async () => ({} as any),
    patch: async () => ({} as any),
  };
  const u = { heygenKey: null, elevenlabsKey: null, heygenAvatarId: null, geminiVoiceName: null, elevenlabsVoiceId: null };

  const noBrands = await getVideoOptions(mockCaller, u);
  check("subtitle.sizeRange is [30,160] and default matches DEFAULT_V2_SUB.fontSize",
    JSON.stringify(noBrands.subtitle.sizeRange) === JSON.stringify([30, 160])
    && noBrands.subtitle.default === DEFAULT_V2_SUB.fontSize);
  check("subtitle.styles lists exactly the V2_QUICK_STYLES ids",
    JSON.stringify(noBrands.subtitle.styles.map((s) => s.id)) === JSON.stringify(V2_QUICK_STYLES.map((s) => s.key)));
  check("subtitle.brands defaults to empty when the route passes none", noBrands.subtitle.brands.length === 0);

  const withBrands = await getVideoOptions(mockCaller, u, [{ brandProfileId: "bp1", name: "Mewsocial" }]);
  check("subtitle.brands passes through what the route resolved",
    withBrands.subtitle.brands.length === 1 && withBrands.subtitle.brands[0].brandProfileId === "bp1");
}

// ── E. route.ts wiring (source-grep, same pattern as verify-mcp-gemini-voice-style.ts) ──
console.log("E) [transport]/route.ts wiring");
{
  const routeSrc = readFileSync(join(__dirname, "..", "src", "app", "api", "[transport]", "route.ts"), "utf8");
  check("create_video_job resolves the Brand Subtitle Style via resolveMcpBrandSubtitleStyle",
    routeSrc.includes("resolveMcpBrandSubtitleStyle(p.userId, args.brandProfileId)"));
  check("a foreign/inactive brandProfileId returns a generic brand_not_found error",
    routeSrc.includes('return { error: "brand_not_found"'));
  check("no explicit brandProfileId: active brands are listed and a lone one auto-picks",
    routeSrc.includes("listActiveBrandProfilesForMcp(p.userId)") && routeSrc.includes("activeBrands.length === 1"));
  check("the multi-brand warning uses the exact spec text with the live count",
    routeSrc.includes("`มีแบรนด์ให้เลือก ${activeBrands.length} แบรนด์ — ระบุ brandProfileId เพื่อใช้สไตล์ซับของแบรนด์`"));
  check("create_video_job resolves the design via resolveMcpSubtitleDesign before persisting",
    routeSrc.includes("resolveMcpSubtitleDesign("));
  check("the resolved design + cardLen are persisted into the job's inputJson",
    routeSrc.includes("subtitleDesign: resolvedSubtitleDesign") && routeSrc.includes("subtitleCardLen: resolvedSubtitleCardLen"));
  check("get_video_options forwards the caller's active brands",
    routeSrc.includes("getVideoOptions(pipelineCaller(p.userId), p.user, await listActiveBrandProfilesForMcp(p.userId))"));
  check("T7 Part B: a resolved brand with no usable subtitle style pushes brandSubtitleStyleMissingWarning into warnings",
    routeSrc.includes("brandSubtitleStyleMissingWarning("));
  check("T7 Part B: resolution order and the multi-brand warning are untouched (still exactly one multi-brand push site)",
    (routeSrc.match(/มีแบรนด์ให้เลือก \$\{activeBrands\.length\} แบรนด์/g) ?? []).length === 1);
}
{
  const orchSrc = readFileSync(join(__dirname, "..", "src", "lib", "mcp", "orchestrator.ts"), "utf8");
  check("orchestrator resolves the persisted design once via resolvedMcpSubtitleDesignFromInput",
    orchSrc.includes("resolvedMcpSubtitleDesignFromInput(input)"));
  check("every maxCardCharsFor() call in the caption block takes the resolved cardBudgetSize (none left bare)",
    !/maxCardCharsFor\(\)/.test(orchSrc));
  check("both buildBurnConfig call sites (avatar-checkpoint-resume and the main path) use the resolved design",
    [...orchSrc.matchAll(/buildBurnConfig\(([^)]*)\)/g)].length === 2
    && [...orchSrc.matchAll(/buildBurnConfig\(([^)]*)\)/g)].every((m) => m[1].includes("heroSubtitleDesign")));
}

// ── F. throwaway-SQLite tests: resolveMcpBrandSubtitleStyle / listActiveBrandProfilesForMcp ─
async function verifyBrandLookup() {
  console.log("F) resolveMcpBrandSubtitleStyle / listActiveBrandProfilesForMcp (DB)");
  const dir = mkdtempSync(join(tmpdir(), "mcp-subtitle-style-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  const { prisma } = await import("../src/lib/prisma");
  const { createBrandProfileFromPayload } = await import("../src/lib/brand-profile-library.server");
  const { resolveMcpBrandSubtitleStyle, listActiveBrandProfilesForMcp } = await import("../src/lib/brand-profile-library.server");

  const owner = await prisma.user.create({ data: { name: "Owner", email: "owner@example.test", plan: "PRO" } });
  const other = await prisma.user.create({ data: { name: "Other", email: "other@example.test", plan: "PRO" } });

  const fullSubtitleConfig = {
    preset: "shadow", effect: "fade", cardLen: "2", fontFamily: "Noto Sans Thai", bold: false,
    fontWeight: 400, fontSize: 64, textColor: "#000000", accentColor: "#00ff00",
    shadow: true, outline: false, outlineSize: 2, verticalPos: 30,
  };
  const basePayload = {
    schemaVersion: 1 as const,
    name: "Mewsocial",
    niche: "creator education",
    audience: "Thai creators",
    script: {
      styleId: null, tone: "direct", bannedWords: [], ctaStyle: "follow", language: "th",
      analysisNotes: "", sampleText: "",
    },
    voice: { provider: "gemini", voiceId: null },
    subtitle: { presetId: null, config: fullSubtitleConfig },
    brandMark: { assetId: null, enabled: false, position: "top-right", sizePct: 18, opacity: 0.9 },
    visual: {
      primaryVisualFormatId: "simple-editorial-story" as const,
      palette: ["#111111", "#F8F5EE", "#38BDF8"],
      personality: "bold raw energetic",
      peopleAndSetting: "Thai creator contexts",
      memorableCues: [],
      visualNotes: "",
      defaultTreatment: "clear and energetic",
    },
  };

  const active = await createBrandProfileFromPayload({ userId: owner.id, payload: basePayload as never });
  const activeWithoutStyle = await createBrandProfileFromPayload({
    userId: owner.id,
    payload: { ...basePayload, name: "No Preset", subtitle: { presetId: null, config: { fontFamily: "Kanit" } } } as never,
  });
  const archived = await createBrandProfileFromPayload({ userId: owner.id, payload: { ...basePayload, name: "Archived" } as never });
  await prisma.brandProfile.update({ where: { id: archived.profile.id }, data: { archivedAt: new Date() } });
  const frozen = await createBrandProfileFromPayload({ userId: owner.id, payload: { ...basePayload, name: "Frozen" } as never });
  await prisma.brandProfile.update({ where: { id: frozen.profile.id }, data: { frozenAt: new Date() } });
  const unpublished = await prisma.brandProfile.create({
    data: { userId: owner.id, name: "Draft only", niche: "", audience: "", tone: "", ctaStyle: "follow", language: "th" },
  });

  const foreignLookup = await resolveMcpBrandSubtitleStyle(other.id, active.profile.id);
  check("a foreign brandProfileId (not owned by the caller) is refused", foreignLookup.found === false);
  const archivedLookup = await resolveMcpBrandSubtitleStyle(owner.id, archived.profile.id);
  check("an archived brand is refused", archivedLookup.found === false);
  const frozenLookup = await resolveMcpBrandSubtitleStyle(owner.id, frozen.profile.id);
  check("a frozen brand is refused", frozenLookup.found === false);
  const unpublishedLookup = await resolveMcpBrandSubtitleStyle(owner.id, unpublished.id);
  check("an unpublished (draft-only, activeRevisionNumber=0) brand is refused", unpublishedLookup.found === false);
  check("foreign/archived/frozen/unpublished are indistinguishable ({found:false} only)",
    JSON.stringify(foreignLookup) === JSON.stringify({ found: false })
    && JSON.stringify(archivedLookup) === JSON.stringify({ found: false })
    && JSON.stringify(frozenLookup) === JSON.stringify({ found: false })
    && JSON.stringify(unpublishedLookup) === JSON.stringify({ found: false }));
  const nonexistentLookup = await resolveMcpBrandSubtitleStyle(owner.id, "does-not-exist");
  check("a nonexistent id is refused the same way as a foreign one", nonexistentLookup.found === false);

  const activeLookup = await resolveMcpBrandSubtitleStyle(owner.id, active.profile.id);
  check("an active, owned brand with a full subtitle preset returns it",
    activeLookup.found === true && activeLookup.style?.fontSize === 64 && activeLookup.style?.verticalPos === 30);
  const activeNoStyleLookup = await resolveMcpBrandSubtitleStyle(owner.id, activeWithoutStyle.profile.id);
  check("an active, owned brand whose subtitle.config is not a full preset returns {found:true, style:null} (defaults apply)",
    activeNoStyleLookup.found === true && activeNoStyleLookup.style === null);

  // T7 Part B: the session-ruling warning fires on exactly this {found:true, style:null}
  // shape, and never on a brand that has a real style.
  check("T7 Part B: the warning fires for the active brand with no usable subtitle style",
    brandSubtitleStyleMissingWarning(activeNoStyleLookup) === BRAND_SUBTITLE_STYLE_MISSING_WARNING);
  check("T7 Part B: the warning does NOT fire for the active brand with a valid subtitle style",
    brandSubtitleStyleMissingWarning(activeLookup) === null);

  const ownerBrands = await listActiveBrandProfilesForMcp(owner.id);
  check("listActiveBrandProfilesForMcp returns only active brands (excludes archived/frozen/unpublished)",
    ownerBrands.length === 2 && ownerBrands.every((b) => b.brandProfileId !== archived.profile.id && b.brandProfileId !== frozen.profile.id));
  const otherBrands = await listActiveBrandProfilesForMcp(other.id);
  check("listActiveBrandProfilesForMcp never leaks another user's brands (IDOR)", otherBrands.length === 0);

  await prisma.$disconnect();
}

// ── G. full orchestrator wiring: resolved size/design actually reach the pipeline ──────
async function verifyOrchestratorWiring() {
  console.log("G) orchestrator wiring: resolved subtitle design reaches split-script + the burn");
  const dir = mkdtempSync(join(tmpdir(), "mcp-subtitle-style-orch-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
  execSync("npx prisma db push --skip-generate", { stdio: "ignore", env: process.env });
  const { runOrchestrator } = await import("../src/lib/mcp/orchestrator");
  const { createVideoJob, parseVideoJobOutput } = await import("../src/lib/mcp/video-job");
  const { prisma } = await import("../src/lib/prisma");

  const now = new Date();
  await prisma.user.create({
    data: {
      id: "u-sub-style", name: "Subtitle Style User", email: "sub-style@example.com",
      plan: "PRO", minutesLimit: 80, minutesUsed: 0,
      usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
      geminiVoiceName: "Aoede", subStatus: "active", stripeSubscriptionId: "sub_style_fixture",
      planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    },
  });
  await prisma.payment.create({
    data: { userId: "u-sub-style", stripeSessionId: "cs_style_fixture", plan: "PRO", amount: 59_900,
      status: "PAID", periodDays: 30, paidAt: now },
  });

  const LONG_TEXT = "สวัสดีครับ วันนี้มาคุยเรื่องการลงทุนในหุ้นเทคโนโลยีที่กำลังเติบโตอย่างรวดเร็วในตลาดโลกต้องอาศัยความอดทนและวินัยในการถือครองระยะยาวเสมอจึงจะได้ผลตอบแทนที่คุ้มค่าครับ ขอบคุณที่ติดตามครับ";
  const AUDIO_MS = 14_000;
  const customSize = 160; // deliberately far from the default 80 — maxCardCharsFor(160) !== maxCardCharsFor(80)
  const customDesign = { ...DEFAULT_V2_SUB, fontSize: customSize, textColor: "#101010", accentColor: "#202020" };

  const bodies: { path: string; body: unknown }[] = [];
  let renderCount = 0;
  const caller: PipelineCaller = {
    async post<T>(path: string, body: unknown): Promise<T> {
      bodies.push({ path, body });
      if (path === "/api/videos/tts-gemini" || path === "/api/videos/tts") {
        return { voiceUrl: "/api/voices/style.m4a", audioDurationMs: AUDIO_MS,
          timing: { provider: "gemini", segments: [{ text: LONG_TEXT, startMs: 0, durationMs: AUDIO_MS }], chars: null } } as T;
      }
      if (path === "/api/videos/split-script") return { cards: null } as T; // fail-open: use deterministic cards
      if (path === "/api/videos/transcribe") return { words: [] } as T;
      if (path === "/api/videos/extract-keywords") {
        return { keywords: ["money"], keywordsPerScene: 5, sceneClipCounts: [1], sceneDurations: [14],
          visualDirection: "", keywordAlternatives: [] } as T;
      }
      if (path === "/api/videos/fetch-stock") return { results: [{ videoUrl: "stock1.mp4", keyword: "money" }] } as T;
      if (path === "/api/videos/generate-config") return { config: { scenes: [], voiceUrl: "/api/voices/style.m4a" } } as T;
      if (path === "/api/videos") return { id: "video-style-1" } as T;
      if (path === "/api/videos/render") { renderCount += 1; return { jobId: `render-${renderCount}` } as T; }
      if (path.startsWith("/api/videos/render-cancel")) return {} as T;
      throw new Error(`stub caller: unexpected POST ${path}`);
    },
    async patch<T>(): Promise<T> { return {} as T; },
    async get<T>(path: string): Promise<T> {
      if (path.startsWith("/api/videos/render-progress")) {
        const n = /render-(\d+)/.exec(path)?.[1] ?? "0";
        return { progress: 100, videoUrl: `/renders/style-out-${n}.mp4`, error: null, stage: "done" } as T;
      }
      if (path === "/api/music") return { tracks: [], userTracks: [] } as T;
      throw new Error(`stub caller: unexpected GET ${path}`);
    },
  };

  const queued = await createVideoJob("u-sub-style", {
    script: LONG_TEXT, voiceProvider: "gemini", subtitleDesign: customDesign, subtitleCardLen: "sentence",
  });
  await prisma.videoJob.update({ where: { id: queued.id }, data: { status: "processing" } });
  await runOrchestrator(queued.id, "u-sub-style", { caller: caller as never, refundOneClip: async () => {}, sleep: async () => {} });
  const done = await prisma.videoJob.findUnique({ where: { id: queued.id } });
  check("G: non-preview job finished", done?.status === "done", `${done?.status} ${done?.errorMessage ?? ""}`);

  const splitScriptCall = bodies.find((b) => b.path === "/api/videos/split-script");
  check("G: the split-script LLM call uses maxCardCharsFor(resolvedSize), not the default",
    (splitScriptCall?.body as { maxCardChars?: number } | undefined)?.maxCardChars === maxCardCharsFor(customSize)
    && maxCardCharsFor(customSize) !== maxCardCharsFor(),
    `split-script maxCardChars=${(splitScriptCall?.body as { maxCardChars?: number } | undefined)?.maxCardChars}, expected ${maxCardCharsFor(customSize)} (default would be ${maxCardCharsFor()})`);

  const renderCalls = bodies.filter((b) => b.path === "/api/videos/render");
  check("G: two render calls — base, then burn", renderCalls.length === 2);
  const burnCall = renderCalls.find((b) => (b.body as { subtitleOverlayConfig?: unknown }).subtitleOverlayConfig);
  const overlay = burnCall?.body as { subtitleOverlayConfig?: Record<string, unknown> } | undefined;
  const overlayConfig = overlay?.subtitleOverlayConfig;
  check("G: the burned overlay carries the resolved (non-default) colors",
    overlayConfig?.fontFamily === customDesign.fontFamily && overlayConfig?.subtitleAccentColor === "#202020");
  const popups = (overlayConfig?.keywordPopups ?? []) as { size?: number; topPercent?: number }[];
  check("G: every burned popup uses the resolved fontSize, not the old MCP default",
    popups.length > 0 && popups.every((p) => p.size === customSize),
    JSON.stringify(popups.map((p) => p.size)));

  const parsedOutput = parseVideoJobOutput(done?.outputJson ?? null);
  check("G: finished job output exists", Boolean(parsedOutput));

  await prisma.$disconnect();
}

verifyVideoOptionsSubtitleShape()
  .then(verifyBrandLookup)
  .then(verifyOrchestratorWiring)
  .catch((error) => {
    failed += 1;
    console.error("  FAIL  D/F/G: threw", error);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("❌ MCP subtitle style verification FAILED");
      process.exit(1);
    }
    console.log("✅ MCP subtitle style: all checks passed");
    process.exit(0);
  });
