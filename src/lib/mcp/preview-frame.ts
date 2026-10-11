import { z } from "zod";
import sharp from "sharp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "@prisma/client";
import { registerGatedTool, type GatingPrincipal } from "@/lib/mcp/tool-gating";
import {
  UNKNOWN_JOB,
  draftImportViews,
  editToolFailure,
  invalidJobId,
  loadState,
  mergedBgVideosForReport,
  reportableWindowEdits,
  resolveHeldRoot,
  type EditToolFailure,
  type EditToolRunner,
} from "@/lib/mcp/edit-tools";
import { toBurnConfig, type PendingEditState } from "@/lib/mcp/pending-edit-draft";
import type { McpChainRow } from "@/lib/mcp/chain-export";
import { RENDER_FPS } from "@/lib/mcp/orchestrator-steps";
import { mcpPublicOrigin } from "@/lib/mcp/tools";
import { mcpImageReply } from "@/lib/mcp/tool-reply";
import { prepareBrollRenderAssets, renderedWindowSpansMs, type BrollCoverageAsset } from "@/lib/broll-coverage";
import { prepareFilledWindowRenderAssets } from "@/lib/broll-placeholders";
import { headlineHookEndFrame } from "@/lib/headline-hook";
import { canManageBrandMark, getBrandAssetPath } from "@/lib/brand-assets.server";
import { resolveBrandVisualAccess } from "@/lib/brand-visual-rollout.server";
import { projectHasAdmittedPersistedPin } from "@/lib/project-look.server";
import { resolveMediaBaseUrl } from "@/lib/render/media-base-url";
import { renderPreviewStill, resolvePreviewServeUrl } from "@/lib/render/preview-still";

/**
 * W4 (EP5 backlog U6): `get_preview_frame` — ONE still JPEG of what `export_video` would produce
 * at `atMs`, pending edit draft included, so an agent can check its edits without exporting.
 * An observation tool, so MCP-only is allowed (ADR 0066). Same auth/ownership as get_edit_state
 * (resolveHeldRoot + loadState), same beta gate (registerGatedTool).
 *
 * What it renders — the export's own props, nothing invented:
 *  - default: the export's burn step (`SubtitleOverlayComposition` with `toBurnConfig(draft)`, the
 *    exact props `export_video` sends) over the current base video: captions, style, headline,
 *    logo.
 *  - when `atMs` falls inside a B-roll window the draft replaces: the free re-render export_video
 *    runs first (`ShortVideoComposition` with the base config's bgVideos + the pending window
 *    edits, merged by `mergeWindowEdits`, laid out by the render route's own coverage pass) with
 *    the draft's captions/headline on top. Durations come from what the clips stored (no
 *    re-probe), and this composition has no logo layer — both said in `notes`.
 *
 * Load on the shared box: per-user 20 stills / 10 min; one still at a time process-wide with one
 * caller allowed to wait (preview-still.ts); 30 s deadline; nothing written to disk per call.
 */

export const PREVIEW_FRAME_RATE_LIMIT = 20;
export const PREVIEW_FRAME_RATE_WINDOW_MS = 10 * 60_000;

export const getPreviewFrameInputShape = {
  jobId: z.string().describe("jobId ที่ได้จาก create_video_job (exportMode \"hold\")"),
  atMs: z.number().describe("เวลาในคลิปที่ต้องการดูภาพ (มิลลิวินาที, 0 ถึง durationMs − 1 ของ get_edit_state)"),
} satisfies z.ZodRawShape;

type PreviewFrameArgs = { jobId?: unknown; atMs?: unknown };

const NEXT_AFTER_PREVIEW =
  "ถ้าภาพยังไม่ตรงใจ แก้ต่อด้วย set_caption_text / set_subtitle_style / set_headline_hook / replace_broll_window แล้วเรียก get_preview_frame ดูอีกครั้ง — ถ้าตรงใจแล้วเรียก export_video(jobId)";
const NEXT_RETRY_LATER = "ลองเรียก get_preview_frame อีกครั้งภายหลัง หรือเรียก export_video(jobId) เมื่อแก้ครบแล้ว (การดูภาพตัวอย่างไม่จำเป็นต่อการส่งออก)";

// ── per-user rate limit (sliding window, process-wide) ──────────────────────────────────────

const globalForRate = globalThis as unknown as { __heroPreviewFrameRate?: Map<string, number[]> };
function rateWindows(): Map<string, number[]> {
  globalForRate.__heroPreviewFrameRate ??= new Map();
  return globalForRate.__heroPreviewFrameRate;
}

export function tryConsumePreviewFrameRate(
  userId: string,
  now = Date.now(),
): { ok: true; at: number } | { ok: false; retryAfterSec: number } {
  const windows = rateWindows();
  const recent = (windows.get(userId) ?? []).filter((at) => at > now - PREVIEW_FRAME_RATE_WINDOW_MS);
  if (recent.length >= PREVIEW_FRAME_RATE_LIMIT) {
    windows.set(userId, recent);
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + PREVIEW_FRAME_RATE_WINDOW_MS - now) / 1_000));
    return { ok: false, retryAfterSec };
  }
  recent.push(now);
  windows.set(userId, recent);
  return { ok: true, at: now };
}

/** Give back a slot that produced no image because of OUR capacity (busy / warming up). */
export function refundPreviewFrameRate(userId: string, at: number): void {
  const recent = rateWindows().get(userId);
  const index = recent?.lastIndexOf(at) ?? -1;
  if (recent && index >= 0) recent.splice(index, 1);
}

export function previewFrameRateUsed(userId: string, now = Date.now()): number {
  return (rateWindows().get(userId) ?? []).filter((at) => at > now - PREVIEW_FRAME_RATE_WINDOW_MS).length;
}

export function resetPreviewFrameRateForTests(): void {
  globalForRate.__heroPreviewFrameRate = new Map();
}

// ── own media only ──────────────────────────────────────────────────────────────────────────

const OWN_MEDIA_PREFIXES = ["/api/renders/", "/renders/", "/api/stocks/", "/api/music/", "/uploads/"];

function trimmedOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

/** Same base the render route uses: RENDER_INTERNAL_BASE_URL (loopback on prod), else the public origin. */
function previewMediaBase(): string {
  const publicBase = process.env.NEXTAUTH_URL?.trim().replace(/\/$/, "") || mcpPublicOrigin();
  return resolveMediaBaseUrl(publicBase, process.env.RENDER_INTERNAL_BASE_URL);
}

/**
 * The absolute URL Chromium may fetch for a stored media src — ONLY our own media paths (on our
 * own origins when absolute). Anything else returns null and is left out of the still: the
 * preview never fetches a third-party URL (the export's render route caches/guards those itself).
 */
function ownMediaUrl(src: unknown, mediaBase: string): string | null {
  if (typeof src !== "string" || !src.trim()) return null;
  let pathname = src.trim();
  if (/^https?:\/\//i.test(pathname)) {
    let parsed: URL;
    try {
      parsed = new URL(pathname);
    } catch {
      return null;
    }
    const own = [mcpPublicOrigin(), process.env.NEXTAUTH_URL, process.env.RENDER_INTERNAL_BASE_URL]
      .map((value) => trimmedOrigin(value ?? undefined))
      .filter(Boolean);
    if (!own.includes(parsed.origin)) return null;
    pathname = `${parsed.pathname}${parsed.search}`;
  }
  if (pathname.startsWith("/music/")) pathname = `/api/music/${pathname.slice("/music/".length)}`;
  if (!pathname.startsWith("/") || pathname.includes("..") || pathname.includes("\\")) return null;
  if (!OWN_MEDIA_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  return `${mediaBase}${pathname}`;
}

// ── what the still shows ────────────────────────────────────────────────────────────────────

type BurnConfig = ReturnType<typeof toBurnConfig>;
type StillPlan = {
  compositionId: "SubtitleOverlayComposition" | "ShortVideoComposition";
  inputProps: Record<string, unknown>;
  durationInFrames: number;
  pendingWindowIndex: number | null;
  logo: boolean;
};

/** HeyGen avatar time ranges (ms) — the avatar covers the frame there, whatever B-roll is under it. */
function avatarRangesMs(state: PendingEditState, durationMs: number): Array<{ startMs: number; endMs: number }> {
  const preview = state.base.preview;
  const mode = preview.avatarMode;
  if (!mode) return [];
  if (mode === "full") return [{ startMs: 0, endMs: durationMs }];
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  const intro = Number(preview.avatarIntroSecs);
  if (mode.startsWith("bookend") && Number.isFinite(intro) && intro > 0) ranges.push({ startMs: 0, endMs: intro * 1_000 });
  const tail = Number(preview.avatarTailSecs);
  if (mode === "bookend-both" && Number.isFinite(tail) && tail > 0) ranges.push({ startMs: durationMs - tail * 1_000, endMs: durationMs });
  return ranges;
}

/** The trusted logo layer for the still: the export's own access rule, the asset read from our
 *  store and embedded (nothing staged to disk). null + a note when the export would refuse it. */
async function previewLogo(user: User, state: PendingEditState, burn: BurnConfig, notes: string[]) {
  const logo = burn.logoOverlay;
  if (!logo?.enabled) return null;
  const allowed = canManageBrandMark(
    user.plan,
    (await resolveBrandVisualAccess(user)).canUse
      || await projectHasAdmittedPersistedPin({ userId: user.id, projectId: state.projectId }),
  );
  if (!allowed) {
    notes.push("ไม่ได้แสดงโลโก้ในภาพนี้ เพราะบัญชีนี้ใช้โลโก้แบรนด์ไม่ได้ (export_video จะไม่ส่งออกพร้อมโลโก้)");
    return null;
  }
  const assetPath = await getBrandAssetPath(user.id, logo.assetId);
  if (!assetPath) {
    notes.push("ไม่ได้แสดงโลโก้ในภาพนี้ เพราะไม่พบไฟล์โลโก้แบรนด์");
    return null;
  }
  try {
    const { data, info } = await sharp(assetPath, { failOn: "error" })
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return {
      src: `data:image/webp;base64,${data.toString("base64")}`,
      position: logo.position,
      sizePct: logo.sizePct,
      opacity: logo.opacity,
      intrinsicWidth: info.width,
      intrinsicHeight: info.height,
    };
  } catch {
    notes.push("ไม่ได้แสดงโลโก้ในภาพนี้ เพราะอ่านไฟล์โลโก้ไม่ได้");
    return null;
  }
}

/** The draft's B-roll windows (pending edits merged) laid out by the render route's own coverage
 *  pass, using the durations the clips stored. null = could not be laid out (path A instead). */
async function coveredBgVideos(
  config: Record<string, unknown>,
  merged: unknown[],
  durationSec: number,
  mediaBase: string,
  notes: string[],
): Promise<BrollCoverageAsset[] | null> {
  const durationBySrc = new Map<string, number>();
  for (const raw of merged) {
    const entry = raw as { src?: unknown; clipDuration?: unknown } | null;
    const seconds = Number(entry?.clipDuration);
    if (typeof entry?.src === "string" && Number.isFinite(seconds) && seconds > 0 && !durationBySrc.has(entry.src)) {
      durationBySrc.set(entry.src, seconds);
    }
  }
  let refused = 0;
  const options = {
    // localPath carries the stored src so the "probe" below can answer from stored durations.
    resolveAsset: (src: string) => {
      const url = ownMediaUrl(src, mediaBase);
      if (!url) {
        refused += 1;
        throw new Error("not our media");
      }
      return { src: url, localPath: src };
    },
    isUsableLocalFile: (src: string) => durationBySrc.has(src),
    probeDurationSec: async (src: string) => durationBySrc.get(src) ?? null,
  };
  try {
    const assets = merged as BrollCoverageAsset[];
    const segments = Array.isArray(config.backgroundColors) && config.backgroundColors.length > 0
      ? await prepareFilledWindowRenderAssets(assets, RENDER_FPS, options)
      : (await prepareBrollRenderAssets(assets, durationSec, RENDER_FPS, {
          ...options,
          requestedWindowCount: config.requestedBrollWindowCount,
        })).coverage.segments;
    if (refused > 0) notes.push(`ข้ามไฟล์ B-roll ${refused} ไฟล์ที่ไม่ได้อยู่ในระบบของเรา`);
    return segments;
  } catch {
    return null;
  }
}

/** Exported for the verify only (it inspects the props a still would be rendered with). */
export async function planStill(
  user: User,
  root: McpChainRow,
  state: PendingEditState,
  burn: BurnConfig,
  atMs: number,
  notes: string[],
): Promise<StillPlan | EditToolFailure> {
  const mediaBase = previewMediaBase();
  const keywordPopups = burn.keywordPopups.filter((popup) => popup.text.trim().length > 0);
  const subtitleLayer = {
    keywordPopups,
    fontFamily: burn.fontFamily,
    subtitleStylePreset: burn.subtitleStylePreset,
    subtitleTextEffect: burn.subtitleTextEffect,
    subtitleAccentColor: burn.subtitleAccentColor,
    subtitleShadow: burn.subtitleShadow,
    subtitleOutline: burn.subtitleOutline,
    subtitleOutlineSize: burn.subtitleOutlineSize,
    ...(burn.headlineHook ? { headlineHook: burn.headlineHook } : {}),
  };

  // Pending B-roll window edits: which ones the next export would actually re-render.
  const { draft, base } = state;
  const config = base.preview.config;
  const configFrames = Number(config.durationInFrames);
  // The re-render's own timeline length (the base config's), as the render route lays it out.
  const shortFrames = Number.isFinite(configFrames) && configFrames > 0 ? Math.round(configFrames) : burn.durationInFrames;
  let pendingWindowIndex: number | null = null;
  let merged: unknown[] | null = null;
  if (draft.windowEdits.length > 0) {
    const imports = await draftImportViews(user.id, draft);
    for (const edit of draft.windowEdits) {
      const row = edit.importId ? imports.get(edit.importId) : null;
      if (edit.importId && (!row || row.status !== "ready" || !row.resultSrc)) {
        notes.push(`ช่วง B-roll #${edit.index} ยังแสดงภาพเดิม เพราะไฟล์ที่นำเข้ายังไม่พร้อม (${row?.status ?? "failed"}) — เช็คด้วย get_edit_state`);
      }
    }
    const resolvable = new Set(reportableWindowEdits(root, draft.windowEdits, imports).map((edit) => edit.index));
    if (resolvable.size > 0) {
      merged = mergedBgVideosForReport(root, base, draft.windowEdits, imports);
      // Same array back = the merge was refused (validation): nothing new to draw.
      if (merged === (config as { bgVideos?: unknown }).bgVideos) merged = null;
    }
    if (merged) {
      const spans = renderedWindowSpansMs(merged, shortFrames / RENDER_FPS, RENDER_FPS);
      for (const index of resolvable) {
        const span = spans.get(index);
        if (span && atMs >= span.startMs && atMs < span.endMs) pendingWindowIndex = index;
      }
    }
  }
  if (pendingWindowIndex !== null) {
    const durationMs = (burn.durationInFrames / RENDER_FPS) * 1_000;
    if (avatarRangesMs(state, durationMs).some((range) => atMs >= range.startMs && atMs < range.endMs)) {
      notes.push(`ช่วง B-roll #${pendingWindowIndex} ที่แก้ไว้อยู่ใต้อวตารในเวลานี้ ภาพจึงแสดงอวตารตามวิดีโอปัจจุบัน`);
      pendingWindowIndex = null;
    }
  }

  if (pendingWindowIndex !== null && merged) {
    const bgVideos = await coveredBgVideos(config, merged, shortFrames / RENDER_FPS, mediaBase, notes);
    if (bgVideos) {
      if (burn.logoOverlay?.enabled) {
        notes.push("ภาพนี้จำลองช่วง B-roll ที่แก้ไว้ จึงยังไม่แสดงโลโก้ — วิดีโอที่ส่งออกจะมีโลโก้ตามเดิม");
      }
      notes.push(`ช่วง B-roll #${pendingWindowIndex} แสดงตามที่แก้ไว้ (ภาพ/การจัดภาพใหม่) ที่จะเรนเดอร์ตอน export_video`);
      return {
        compositionId: "ShortVideoComposition",
        inputProps: {
          ...config,
          // the draft's project-wide transition (set_broll_style without windowIndex), as the
          // export's B-roll re-render applies it
          ...(draft.brollTransition ? { brollTransition: draft.brollTransition } : {}),
          ...subtitleLayer,
          // exactly the draft's headline (or none) — never one baked into the base config
          headlineHook: burn.headlineHook,
          bgVideos,
          voiceFile: "",
          bgmFile: undefined,
          watermark: false,
          durationInFrames: shortFrames,
        },
        durationInFrames: shortFrames,
        pendingWindowIndex,
        logo: false,
      };
    }
    notes.push(`จำลองช่วง B-roll #${pendingWindowIndex} ที่แก้ไว้ไม่ได้ ภาพนี้จึงแสดงวิดีโอปัจจุบัน`);
    pendingWindowIndex = null;
  }

  const videoUrl = ownMediaUrl(burn.videoUrl, mediaBase);
  if (!videoUrl) {
    return editToolFailure("preview_failed", "สร้างภาพตัวอย่างของวิดีโอนี้ไม่ได้", NEXT_RETRY_LATER);
  }
  const logo = await previewLogo(user, state, burn, notes);
  if (draft.brollTransition) {
    notes.push("รอยต่อ B-roll แบบใหม่ทั้งคลิป (set_broll_style transition) ยังไม่แสดงในภาพนี้ — เห็นได้เฉพาะรอยต่อระหว่างช่วงในวิดีโอที่ส่งออก");
  }
  return {
    compositionId: "SubtitleOverlayComposition",
    inputProps: {
      ...subtitleLayer,
      videoUrl,
      durationInFrames: burn.durationInFrames,
      // set_tail_hold: past the voice the export freezes the last video frame
      ...(burn.tailHoldFrames ? { tailHoldFrames: burn.tailHoldFrames } : {}),
      ...(logo ? { logoOverlay: logo } : {}),
    },
    durationInFrames: burn.durationInFrames,
    pendingWindowIndex: null,
    logo: logo !== null,
  };
}

// ── the tool ────────────────────────────────────────────────────────────────────────────────

export async function getPreviewFrameTool(user: User, args: PreviewFrameArgs) {
  const startedAt = Date.now();
  if (invalidJobId(args.jobId)) return UNKNOWN_JOB;
  const held = await resolveHeldRoot(user.id, args.jobId as string);
  if (!held.ok) return held.failure;
  const loaded = await loadState(user.id, held.root);
  if (!loaded.ok) return loaded.failure;
  const { state } = loaded;

  const burn = toBurnConfig(state.draft, state.base);
  const totalFrames = burn.durationInFrames;
  const durationMs = Math.round((totalFrames / RENDER_FPS) * 1_000);
  const rawAtMs = args.atMs;
  if (typeof rawAtMs !== "number" || !Number.isFinite(rawAtMs) || rawAtMs < 0 || rawAtMs >= durationMs) {
    return editToolFailure(
      "invalid_input",
      `atMs ต้องเป็นตัวเลขระหว่าง 0 ถึง ${durationMs - 1} (ความยาวคลิป ${durationMs} ms)`,
      "ส่ง atMs ใหม่ภายในความยาวคลิป (ดู durationMs / captions[].startMs ใน get_edit_state)",
    );
  }
  const atMs = Math.round(rawAtMs);
  const frame = Math.min(totalFrames - 1, Math.floor((atMs * RENDER_FPS) / 1_000));

  // The limit is taken before any heavier work (logo decode, B-roll layout, render); every
  // refusal above is free, and a refusal caused by our own capacity is refunded below.
  const rate = tryConsumePreviewFrameRate(user.id);
  if (!rate.ok) {
    return {
      ...editToolFailure(
        "rate_limited",
        `ขอภาพตัวอย่างได้ไม่เกิน ${PREVIEW_FRAME_RATE_LIMIT} ภาพต่อ 10 นาที — รอประมาณ ${rate.retryAfterSec} วินาทีแล้วลองใหม่`,
        "แก้ต่อได้ตามปกติระหว่างรอ แล้วค่อยขอภาพตัวอย่างเมื่อแก้ครบ หรือเรียก export_video(jobId) ได้เลย",
      ),
      retryAfterSec: rate.retryAfterSec,
    };
  }

  const notes: string[] = [];
  const plan = await planStill(user, held.root, state, burn, atMs, notes);
  if ("error" in plan) {
    refundPreviewFrameRate(user.id, rate.at);
    return plan;
  }

  const serve = await resolvePreviewServeUrl();
  if (!serve.ok) {
    refundPreviewFrameRate(user.id, rate.at);
    if (serve.reason === "warming_up") {
      return {
        ...editToolFailure(
          "preview_warming_up",
          "ระบบกำลังเตรียมตัวสร้างภาพตัวอย่าง (ครั้งแรกหลังอัปเดตระบบ) — ลองใหม่ในอีกประมาณ 30 วินาที",
          "รอประมาณ 30 วินาทีแล้วเรียก get_preview_frame อีกครั้ง (ไม่นับโควต้าภาพตัวอย่าง)",
        ),
        retryAfterSec: 30,
      };
    }
    return editToolFailure("preview_failed", "สร้างภาพตัวอย่างไม่สำเร็จ", NEXT_RETRY_LATER);
  }

  const still = await renderPreviewStill({
    serveUrl: serve.serveUrl,
    compositionId: plan.compositionId,
    inputProps: plan.inputProps,
    frame: Math.min(frame, plan.durationInFrames - 1),
    durationInFrames: plan.durationInFrames,
  });
  if (!still.ok) {
    if (still.reason === "busy") {
      refundPreviewFrameRate(user.id, rate.at);
      return {
        ...editToolFailure(
          "preview_busy",
          "ตอนนี้ระบบกำลังสร้างภาพตัวอย่างอื่นอยู่ — ลองใหม่ในอีกสักครู่",
          "รอประมาณ 15 วินาทีแล้วเรียก get_preview_frame อีกครั้ง (ไม่นับโควต้าภาพตัวอย่าง) — แก้ต่อระหว่างรอได้",
        ),
        retryAfterSec: 15,
      };
    }
    if (still.reason === "timeout") {
      return editToolFailure("preview_timeout", "สร้างภาพตัวอย่างไม่ทันเวลา (30 วินาที)", NEXT_RETRY_LATER);
    }
    return editToolFailure("preview_failed", "สร้างภาพตัวอย่างไม่สำเร็จ", NEXT_RETRY_LATER);
  }

  const hookEndFrame = burn.headlineHook ? headlineHookEndFrame(burn.headlineHook, RENDER_FPS, totalFrames) : 0;
  const headline = !!burn.headlineHook?.enabled && frame < hookEndFrame;
  const captionIndex = headline
    ? -1
    : burn.keywordPopups.findIndex((popup) => popup.text.trim() && frame >= popup.start && frame < popup.end);
  const totalMs = Date.now() - startedAt;
  // One line per still: latency + which bundle served it. No ids beyond the job, no content.
  console.log(`[get_preview_frame] job=${held.root.id} frame=${frame} composition=${plan.compositionId} bundle=${serve.source} bundleMs=${serve.bundleMs} renderMs=${still.renderMs} totalMs=${totalMs} bytes=${still.jpeg.length}`);

  return mcpImageReply(still.jpeg, "image/jpeg", {
    jobId: held.root.id,
    atMs,
    frame,
    durationMs,
    draftRevision: state.revision,
    includes: {
      headline,
      captionIndex: captionIndex >= 0 ? captionIndex : null,
      captionText: captionIndex >= 0 ? state.draft.captions[captionIndex]?.text ?? null : null,
      logo: plan.logo,
      pendingWindowIndex: plan.pendingWindowIndex,
    },
    notes,
    image: { width: still.width, height: still.height, bytes: still.jpeg.length },
    timing: { totalMs, bundleMs: serve.bundleMs, renderMs: still.renderMs, bundle: serve.source },
    next: NEXT_AFTER_PREVIEW,
  });
}

const GATE_NEXT = "ใช้ create_video_job / get_video_status ตามปกติ (วิดีโอจะส่งออกอัตโนมัติ)";
const RUN_NEXT = "ลองเรียกเครื่องมือนี้อีกครั้ง หรือเรียก get_edit_state เพื่อดูดราฟต์";

/** Registers get_preview_frame for this request's principal (same beta gate as the edit tools). */
export function registerPreviewFrameTool(server: McpServer, principal: GatingPrincipal, runTool: EditToolRunner): void {
  registerGatedTool(
    server,
    principal,
    "get_preview_frame",
    {
      title: "Get preview frame",
      description:
        "ดูภาพนิ่ง 1 ภาพ (JPEG 540x960) ของวิดีโอที่ส่งออกจะได้ ณ เวลา atMs — รวมทุกการแก้ในดราฟต์ที่ยังไม่ส่งออก (ข้อความซับ, สไตล์ซับ, พาดหัว, B-roll ที่เปลี่ยน) ใช้เช็คผลการแก้ก่อน export_video โดยไม่ต้องเรนเดอร์ทั้งคลิป. ไม่ตัดโควต้าคลิป; จำกัด 20 ภาพต่อ 10 นาที และสร้างทีละภาพทั้งระบบ — ถ้าได้ preview_busy ให้รอ ~15 วินาทีแล้วลองใหม่.",
      inputSchema: getPreviewFrameInputShape,
    },
    async (args, extra) =>
      runTool("get_preview_frame", extra, (p) => getPreviewFrameTool(p.user, args), args, { next: RUN_NEXT }),
    { next: GATE_NEXT },
  );
}
