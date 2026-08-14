import { createHash } from "node:crypto";
import type { ContentPreflight, ProjectVisualBeat } from "@prisma/client";
import { z } from "zod";
import { VISUAL_FORMAT_IDS, type VisualFormatId } from "@/lib/brand-visual-system";
import { prisma } from "@/lib/prisma";
import {
  linkCompletedVisualBeatAsset,
  reusableProjectVisualAssets,
} from "@/lib/project-visual-assets.server";
import { geminiGenerateText } from "@/lib/gemini";
import { KeyRequiredError, resolveGeminiKey } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";
import {
  applySceneContentPolicy,
  isDefaultSceneContentPolicy,
  sceneContentPolicyFromPreference,
  sceneContentPolicyIdentity,
  sceneContentPolicyPromptBlock,
  sceneContentPolicyWarnings,
  type SceneContentPolicy,
  type SceneContentPolicyWarning,
} from "@/lib/scene-content-policy";

/** Bumped whenever the extraction prompt changes what a beat contains, so a
 * project cannot keep serving beats produced by a superseded analyzer: the
 * preflight cache is keyed on this string. `-v5` replaces `-v4`'s
 * language-blind focal-subject ban with a writing-system rule: a surface that
 * must be read may be what a beat is about, and its wording is written in
 * English (ADR 0007). */
export const CONTENT_PREFLIGHT_ANALYZER_VERSION = "brand-content-preflight-v5-latin-lettering";
/** Read-only lineage. A superseded row is still a valid source of a previous
 * beat's generated asset, so a bump costs one re-analysis and never an image:
 * beats whose `sourceExcerptHash` is unchanged carry their asset forward. */
const COMPATIBLE_CONTENT_PREFLIGHT_ANALYZER_VERSIONS = [
  CONTENT_PREFLIGHT_ANALYZER_VERSION,
  "brand-content-preflight-v4-focal-subject",
  "brand-content-preflight-v3-stable-windows",
  "brand-content-preflight-v2-windowed",
] as const;
export type NarrativeSourceKind = "ai-script" | "creator-script" | "upload-transcript";
export type NarrativeVisualWindow = { text: string; startMs?: number; endMs?: number };

const analysisSchema = z.object({
  contentDomain: z.string().trim().min(1).max(160),
  suggestedVisualFormatId: z.enum(VISUAL_FORMAT_IDS),
  suggestedTreatment: z.object({
    label: z.string().trim().min(1).max(120),
    mood: z.string().trim().min(1).max(240),
  }),
  beats: z.array(z.object({
    beatKey: z.string().trim().min(1).max(120),
    sourceExcerpt: z.string().trim().min(1).max(1_000),
    startMs: z.number().int().min(0).optional(),
    endMs: z.number().int().positive().optional(),
    subject: z.string().trim().min(1).max(500),
    action: z.string().trim().min(1).max(500),
    setting: z.string().trim().min(1).max(500),
    emotion: z.string().trim().min(1).max(300),
    emphasis: z.string().trim().min(1).max(500),
    policyApplicability: z.enum(["applied", "not-applicable", "story-conflict"]).optional(),
    policyConflict: z.string().trim().max(300).optional(),
    sceneContentPolicy: z.object({
      locale: z.enum(["narrative", "thai", "asian", "european", "global"]),
      people: z.enum(["narrative", "avoid-visible-people"]),
    }).optional(),
    policyFallbackApplied: z.boolean().optional(),
  })).min(1).max(120).superRefine((beats, context) => {
    const keys = new Set<string>();
    beats.forEach((beat, index) => {
      if (keys.has(beat.beatKey)) {
        context.addIssue({ code: "custom", message: "Visual Beat keys must be unique", path: [index, "beatKey"] });
      }
      keys.add(beat.beatKey);
    });
  }),
});

export type ContentPreflightAnalysis = z.infer<typeof analysisSchema>;

export type ContentPreflightAnalyzer = {
  analyze(input: {
    kind: NarrativeSourceKind;
    text: string;
    windows: NarrativeVisualWindow[];
    sceneContentPolicy?: SceneContentPolicy;
  }): Promise<ContentPreflightAnalysis>;
};

export type ResolvedVisualBeat = ContentPreflightAnalysis["beats"][number] & {
  id: string;
  status: string;
  existingAssetUrl: string | null;
};

export type ResolvedContentPreflight = {
  id: string;
  sourceHash: string;
  contentDomain: string;
  suggestedVisualFormatId: VisualFormatId;
  suggestedTreatment: ContentPreflightAnalysis["suggestedTreatment"];
  visualBeats: ResolvedVisualBeat[];
  sceneContentPolicy: SceneContentPolicy;
  policyWarnings: SceneContentPolicyWarning[];
  cached: boolean;
};

/** Exact story windows owned by one immutable preflight. The worker consumes
 * this same ordered list when it lays B-roll onto the TTS timeline. */
export async function narrativeVisualWindowsForPreflight(input: {
  userId: string;
  projectId: string;
  preflightId: string;
}): Promise<NarrativeVisualWindow[]> {
  const beats = await prisma.projectVisualBeat.findMany({
    where: {
      userId: input.userId,
      projectId: input.projectId,
      preflightId: input.preflightId,
    },
    orderBy: { sequence: "asc" },
    select: { sequence: true, startMs: true, endMs: true, beatJson: true },
  });
  if (beats.length === 0 || beats.some((beat, index) => beat.sequence !== index)) {
    throw new ContentPreflightError("INVALID_ANALYSIS", "ข้อมูลฉากมีลำดับไม่ครบ");
  }
  const windows = beats.map((beat) => {
    let sourceExcerpt = "";
    try {
      const parsed = JSON.parse(beat.beatJson) as { sourceExcerpt?: unknown };
      sourceExcerpt = typeof parsed.sourceExcerpt === "string" ? parsed.sourceExcerpt : "";
    } catch {}
    return {
      text: sourceExcerpt,
      ...(beat.startMs !== null ? { startMs: beat.startMs } : {}),
      ...(beat.endMs !== null ? { endMs: beat.endMs } : {}),
    };
  });
  const normalized = normalizedWindows(windows);
  if (normalized.length !== beats.length) {
    throw new ContentPreflightError("INVALID_ANALYSIS", "ข้อมูลช่วงเนื้อหาสำหรับแต่ละฉากไม่ครบ");
  }
  return normalized;
}

export class ContentPreflightError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "INVALID_SOURCE"
      | "ANALYZER_UNAVAILABLE"
      | "INVALID_ANALYSIS"
      | "KEY_REQUIRED"
      | "TEXT_QUOTA",
    message: string,
  ) {
    super(message);
    this.name = "ContentPreflightError";
  }
}

/** Production adapter for the external text-model seam. It reserves one call
 * only when resolveContentPreflight has a cache miss; analysis itself never
 * consumes image allowance or credits. */
type ContentPreflightTextGenerator = typeof geminiGenerateText;

function contentPreflightResponseJsonSchema(beatCount: number): Record<string, unknown> {
  const beat = {
    type: "object",
    additionalProperties: false,
    properties: {
      beatKey: { type: "string" },
      sourceExcerpt: { type: "string" },
      startMs: { type: "integer", minimum: 0 },
      endMs: { type: "integer", minimum: 1 },
      subject: { type: "string" },
      action: { type: "string" },
      setting: { type: "string" },
      emotion: { type: "string" },
      emphasis: { type: "string" },
      policyApplicability: {
        type: "string",
        enum: ["applied", "not-applicable", "story-conflict"],
      },
      policyConflict: { type: "string" },
    },
    required: [
      "beatKey",
      "sourceExcerpt",
      "subject",
      "action",
      "setting",
      "emotion",
      "emphasis",
    ],
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      contentDomain: { type: "string" },
      suggestedVisualFormatId: { type: "string", enum: [...VISUAL_FORMAT_IDS] },
      suggestedTreatment: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          mood: { type: "string" },
        },
        required: ["label", "mood"],
      },
      beats: {
        type: "array",
        items: beat,
        minItems: beatCount,
        maxItems: beatCount,
      },
    },
    required: ["contentDomain", "suggestedVisualFormatId", "suggestedTreatment", "beats"],
  };
}

export function createGeminiContentPreflightAnalyzer(
  userId: string,
  generateText: ContentPreflightTextGenerator = geminiGenerateText,
): ContentPreflightAnalyzer {
  return {
    async analyze(input) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { geminiKey: true, plan: true },
      });
      if (!user) throw new ContentPreflightError("NOT_FOUND", "ไม่พบบัญชีนี้");
      let key: string;
      let mode: "managed" | "byok";
      try {
        const resolved = resolveGeminiKey(user);
        key = resolved.key;
        mode = resolved.mode;
      } catch (error) {
        if (error instanceof KeyRequiredError) {
          throw new ContentPreflightError("KEY_REQUIRED", "กรุณาเชื่อม Gemini ก่อนวิเคราะห์เนื้อหา");
        }
        throw error;
      }
      const reservation = await reserveAiTextCall(userId, { enforce: mode === "managed" });
      if (!reservation.allowed) {
        throw new ContentPreflightError("TEXT_QUOTA", reservation.message || "ใช้สิทธิ์วิเคราะห์ข้อความครบแล้ว");
      }

      const policyPrompt = sceneContentPolicyPromptBlock(
        sceneContentPolicyFromPreference(input.sceneContentPolicy),
      );
      const raw = await generateText(key, [
        "Analyze this Narrative Source for a vertical short-form video.",
        "Return one JSON object only. Do not wrap it in markdown.",
        `sourceKind: ${input.kind}`,
        "Choose suggestedVisualFormatId from: cinematic-realism, stick-figure-story, dramatic-comic, clear-infographic, retro-story.",
        `Return exactly ${input.windows.length} beats, one for each supplied B-roll window, in the same order. Use beatKey window-0, window-1, and so on.`,
        // The image model renders lettering as authentic-looking nonsense in some
        // writing systems, and it has no negative-prompt channel to suppress that
        // with (z-image-turbo is `negativePromptDelivery: "ignored"`). The only
        // channel that reaches it is the positive prompt, and the positive prompt
        // is built from these beats — so the one safe place to intervene is what
        // is requested, never how it is rendered.
        //
        // The failure mode is a writing system, not a subject: the 8-image probe
        // of 2026-08-10 rendered English correctly up to a nine-word sentence and
        // rendered Thai as authentic-looking glyphs that spell nothing. `-v4`
        // stated this as a language-blind ban on signage being focal, which also
        // cost the English signage a story may genuinely be about. `-v5` names
        // the writing system instead: the beat may centre on a surface that must
        // be read, and its wording is requested in English whatever language the
        // source is in. `v3PositiveArtDirectionValue` in `brand-visual-system.ts`
        // is the deterministic backstop if a beat comes back in Thai anyway.
        "Each beat must describe one frozen visual moment — people, objects, places, light and physical action — not a montage and not typography.",
        "Write every field in English, whatever language the Narrative Source is written in.",
        "A sign, banner, poster, screen or page may be what a beat is about when the source is genuinely about what it displays. Whenever a beat describes something that is read, give its wording in English using the Latin alphabet and quote the exact English words. Describe lettering in no other writing system.",
        // Without this, "avoid signage" comes back as `setting: "a street with no
        // signs"` — and a diffusion text encoder reads a negated concept as a
        // positive cue, so the beat would draw the very thing it excluded.
        "Write only what is present in the frame. Never phrase a field as an absence, and never name something in order to exclude it.",
        policyPrompt,
        "Schema: {contentDomain:string,suggestedVisualFormatId:string,suggestedTreatment:{label:string,mood:string},beats:[{beatKey:string,sourceExcerpt:string,startMs?:integer,endMs?:integer,subject:string,action:string,setting:string,emotion:string,emphasis:string,policyApplicability?:'applied'|'not-applicable'|'story-conflict',policyConflict?:string}]}",
        "B-roll windows (authoritative; copy each text into the matching sourceExcerpt):",
        JSON.stringify(input.windows),
        "Narrative Source:",
        input.text,
      ].join("\n"), Math.min(65_536, Math.max(8_192, input.windows.length * 512)), 0.2, {
        responseMimeType: "application/json",
        responseJsonSchema: contentPreflightResponseJsonSchema(input.windows.length),
      });
      try {
        return JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim()) as ContentPreflightAnalysis;
      } catch {
        throw new ContentPreflightError("INVALID_ANALYSIS", "AI ส่งผลวิเคราะห์ที่อ่านไม่ได้ กรุณาลองใหม่");
      }
    },
  };
}

function normalizedNarrative(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

export function planNarrativeVisualWindows(
  text: string,
  requestedCount?: number,
): NarrativeVisualWindow[] {
  const normalized = normalizedNarrative(text);
  if (!normalized) return [];
  const manualCount = Number.isFinite(requestedCount) && (requestedCount ?? 0) > 0
    ? Math.min(60, Math.max(1, Math.floor(requestedCount!)))
    : 0;
  const thaiChars = (normalized.match(/[฀-๿]/g) ?? []).length;
  const englishWords = normalized.replace(/[฀-๿]/g, " ").split(/\s+/).filter(Boolean).length;
  const estimatedSeconds = thaiChars / 11 + englishWords / 2.5;
  const count = manualCount || Math.min(60, Math.max(1, Math.ceil(estimatedSeconds / 4)));
  const units = normalized
    .split(/\n+/u)
    .flatMap((line) => line.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu) ?? [])
    .map((unit) => unit.trim())
    .filter(Boolean);
  const windows = units.length > 0 ? units : [normalized];

  // Grow at natural boundaries first. Thai often has no whitespace, so the
  // fallback splits Unicode code points near the midpoint rather than bytes.
  while (windows.length < count) {
    let longestIndex = -1;
    let longestLength = 0;
    windows.forEach((window, index) => {
      const length = Array.from(window).length;
      if (length > longestLength && length > 1) {
        longestIndex = index;
        longestLength = length;
      }
    });
    if (longestIndex < 0) {
      windows.push(windows[windows.length - 1] ?? normalized);
      continue;
    }
    const window = windows[longestIndex];
    const characters = Array.from(window);
    const midpoint = Math.floor(characters.length / 2);
    const whitespaceCandidates = characters
      .map((character, index) => (/\s/u.test(character) ? index : -1))
      .filter((index) => index > 0 && index < characters.length - 1)
      .sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint));
    const splitAt = whitespaceCandidates[0] ?? midpoint;
    const left = characters.slice(0, splitAt).join("").trim();
    const right = characters.slice(splitAt).join("").trim();
    if (!left || !right) {
      windows.push(window);
      continue;
    }
    windows.splice(longestIndex, 1, left, right);
  }

  // When the narrative has more natural units than requested windows, merge
  // the smallest adjacent pair. Boundaries stay anchored to sentences/lines,
  // so a local prefix edit cannot shift every later Visual Beat.
  while (windows.length > count) {
    let mergeAt = 0;
    let smallest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < windows.length - 1; index += 1) {
      const combined = Array.from(windows[index]).length + Array.from(windows[index + 1]).length;
      if (combined < smallest) {
        smallest = combined;
        mergeAt = index;
      }
    }
    windows.splice(mergeAt, 2, `${windows[mergeAt]}\n${windows[mergeAt + 1]}`);
  }

  return windows.map((window) => ({ text: window }));
}

function normalizedWindows(windows: readonly NarrativeVisualWindow[]): NarrativeVisualWindow[] {
  return windows.slice(0, 120).flatMap((window) => {
    const text = normalizedNarrative(window.text);
    if (!text) return [];
    const startMs = Number.isSafeInteger(window.startMs) && (window.startMs ?? -1) >= 0
      ? window.startMs
      : undefined;
    const endMs = Number.isSafeInteger(window.endMs) && (window.endMs ?? 0) > 0
      ? window.endMs
      : undefined;
    return [{ text, ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs } : {}) }];
  });
}

export function contentPreflightSourceHash(
  kind: NarrativeSourceKind,
  text: string,
  options: {
    windowCount?: number;
    windows?: readonly NarrativeVisualWindow[];
    sceneContentPolicy?: unknown;
  } = {},
): string {
  const normalized = normalizedNarrative(text);
  const windows = normalizedWindows(
    options.windows ?? planNarrativeVisualWindows(normalized, options.windowCount),
  );
  const sceneContentPolicy = sceneContentPolicyFromPreference(options.sceneContentPolicy);
  return createHash("sha256")
    .update(JSON.stringify({
      kind,
      text: normalized,
      windows,
      ...(!isDefaultSceneContentPolicy(sceneContentPolicy)
        ? { sceneContentPolicy: sceneContentPolicyIdentity(sceneContentPolicy) }
        : {}),
    }))
    .digest("hex");
}

function sourceWindowHash(sourceExcerpt: string, rawPolicy?: unknown): string {
  const sceneContentPolicy = sceneContentPolicyFromPreference(rawPolicy);
  const normalized = normalizedNarrative(sourceExcerpt).normalize("NFKC").toLocaleLowerCase();
  return createHash("sha256")
    .update(isDefaultSceneContentPolicy(sceneContentPolicy)
      ? normalized
      : JSON.stringify({ sourceExcerpt: normalized, sceneContentPolicy: sceneContentPolicyIdentity(sceneContentPolicy) }))
    .digest("hex");
}

function storedSourceWindowHash(beat: ProjectVisualBeat): string {
  try {
    const parsed = JSON.parse(beat.beatJson) as { sourceExcerpt?: unknown; sceneContentPolicy?: unknown };
    if (typeof parsed.sourceExcerpt === "string" && parsed.sourceExcerpt.trim()) {
      return sourceWindowHash(parsed.sourceExcerpt, parsed.sceneContentPolicy);
    }
  } catch {}
  return beat.sourceExcerptHash;
}

type StoredPreflight = ContentPreflight & { visualBeats: ProjectVisualBeat[] };

function resolved(row: StoredPreflight, cached: boolean): ResolvedContentPreflight {
  const treatment = JSON.parse(row.suggestedTreatmentJson) as ContentPreflightAnalysis["suggestedTreatment"];
  const visualBeats = row.visualBeats
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((beat) => ({
      ...(JSON.parse(beat.beatJson) as ContentPreflightAnalysis["beats"][number]),
      id: beat.id,
      status: beat.status,
      existingAssetUrl: beat.existingAssetUrl,
    }));
  const sceneContentPolicy = sceneContentPolicyFromPreference(visualBeats[0]?.sceneContentPolicy);
  return {
    id: row.id,
    sourceHash: row.sourceHash,
    contentDomain: row.contentDomain,
    suggestedVisualFormatId: row.suggestedVisualFormatId as VisualFormatId,
    suggestedTreatment: treatment,
    visualBeats,
    sceneContentPolicy,
    policyWarnings: sceneContentPolicyWarnings(visualBeats),
    cached,
  };
}

/** Cache identity owns analysis, not mutable asset lineage. When a creator
 * returns to an already-analyzed source, copy only exact current windows from
 * the explicitly named predecessor into cache rows that do not already own a
 * current asset. This keeps analysis lazy without losing later generations. */
async function rebaseCachedPreflightAssetsFromLineage(input: {
  userId: string;
  projectId: string;
  cachedPreflightId: string;
  previousPreflightId: string;
}): Promise<StoredPreflight> {
  return prisma.$transaction(async (tx) => {
    const [cached, previous] = await Promise.all([
      tx.contentPreflight.findFirst({
        where: {
          id: input.cachedPreflightId,
          projectId: input.projectId,
          userId: input.userId,
        },
        include: { visualBeats: true },
      }),
      tx.contentPreflight.findFirst({
        where: {
          id: input.previousPreflightId,
          projectId: input.projectId,
          userId: input.userId,
        },
        include: { visualBeats: true },
      }),
    ]);
    if (!cached || !previous || cached.id === previous.id) {
      if (!cached) throw new ContentPreflightError("NOT_FOUND", "ไม่พบข้อมูลฉากที่บันทึกไว้");
      return cached;
    }

    const targets = cached.visualBeats.slice().sort((a, b) => a.sequence - b.sequence);
    const sources = previous.visualBeats
      .filter((beat) => beat.status === "current"
        && Boolean(beat.existingAssetUrl)
        && Boolean(beat.existingImageJobId))
      .sort((a, b) => a.sequence - b.sequence);
    const usedSourceIds = new Set<string>();

    for (const target of targets) {
      const targetHash = storedSourceWindowHash(target);
      const source = sources
        .filter((candidate) => !usedSourceIds.has(candidate.id)
          && storedSourceWindowHash(candidate) === targetHash)
        .sort((a, b) => Math.abs(a.sequence - target.sequence) - Math.abs(b.sequence - target.sequence))[0];
      if (!source) continue;
      usedSourceIds.add(source.id);
      const ownsCurrentAsset = target.status === "current"
        && Boolean(target.existingAssetUrl)
        && Boolean(target.existingImageJobId);
      if (ownsCurrentAsset) continue;
      await tx.projectVisualBeat.updateMany({
        where: {
          id: target.id,
          userId: input.userId,
          OR: [
            { status: { not: "current" } },
            { existingAssetUrl: null },
            { existingImageJobId: null },
          ],
        },
        data: {
          existingAssetUrl: source.existingAssetUrl,
          existingImageJobId: source.existingImageJobId,
          generationIdentityKey: source.generationIdentityKey,
          status: "current",
          outdatedAt: null,
        },
      });
    }

    return tx.contentPreflight.findUniqueOrThrow({
      where: { id: cached.id },
      include: { visualBeats: true },
    });
  });
}

/** Resolve once per normalized Narrative Source and analyzer version. The
 * external analyzer sits behind an injected port; persistence and callers see
 * only the structured Content Preflight interface. */
export async function resolveContentPreflight(input: {
  userId: string;
  projectId: string;
  previousPreflightId?: string;
  narrativeSource: {
    kind: NarrativeSourceKind;
    text: string;
    windowCount?: number;
    windows?: NarrativeVisualWindow[];
    sceneContentPolicy?: unknown;
  };
  analyzer?: ContentPreflightAnalyzer;
}): Promise<ResolvedContentPreflight> {
  const text = normalizedNarrative(input.narrativeSource.text);
  if (!text || text.length > 50_000) {
    throw new ContentPreflightError("INVALID_SOURCE", "Narrative Source ต้องมีความยาว 1–50,000 ตัวอักษร");
  }
  const project = await prisma.editorProject.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { id: true },
  });
  if (!project) throw new ContentPreflightError("NOT_FOUND", "ไม่พบโปรเจกต์นี้");
  if (input.previousPreflightId) {
    const previousExists = await prisma.contentPreflight.findFirst({
      where: {
        id: input.previousPreflightId,
        projectId: project.id,
        userId: input.userId,
      },
      select: { id: true },
    });
    if (!previousExists) {
      throw new ContentPreflightError("INVALID_SOURCE", "ข้อมูลฉากชุดก่อนหน้าไม่ตรงกับโปรเจกต์นี้");
    }
  }
  const windows = normalizedWindows(
    input.narrativeSource.windows
      ?? planNarrativeVisualWindows(text, input.narrativeSource.windowCount),
  );
  if (windows.length === 0 || windows.length > 120) {
    throw new ContentPreflightError("INVALID_SOURCE", "Narrative Source ไม่มี B-roll window ที่ใช้วิเคราะห์ได้");
  }
  const sceneContentPolicy = sceneContentPolicyFromPreference(input.narrativeSource.sceneContentPolicy);
  const sourceHash = contentPreflightSourceHash(input.narrativeSource.kind, text, {
    windows,
    sceneContentPolicy,
  });
  const cached = await prisma.contentPreflight.findUnique({
    where: {
      projectId_sourceHash_analyzerVersion: {
        projectId: project.id,
        sourceHash,
        analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
      },
    },
    include: { visualBeats: true },
  });
  if (cached) {
    const rebased = input.previousPreflightId
      ? await rebaseCachedPreflightAssetsFromLineage({
          userId: input.userId,
          projectId: project.id,
          cachedPreflightId: cached.id,
          previousPreflightId: input.previousPreflightId,
        })
      : cached;
    return resolved(rebased, true);
  }
  if (!input.analyzer) {
    throw new ContentPreflightError("ANALYZER_UNAVAILABLE", "ยังไม่ได้เชื่อมตัววิเคราะห์เนื้อหา");
  }

  const analyzed = analysisSchema.safeParse(await input.analyzer.analyze({
    kind: input.narrativeSource.kind,
    text,
    windows,
    sceneContentPolicy,
  }));
  if (!analyzed.success) {
    throw new ContentPreflightError(
      "INVALID_ANALYSIS",
      analyzed.error.issues[0]?.message || "ผลวิเคราะห์เนื้อหาไม่ครบ",
    );
  }
  if (analyzed.data.beats.length !== windows.length) {
    throw new ContentPreflightError(
      "INVALID_ANALYSIS",
      `ผลวิเคราะห์ต้องมีข้อมูลครบทั้ง ${windows.length} ฉาก`,
    );
  }
  const policyApplied = applySceneContentPolicy(analyzed.data.beats, sceneContentPolicy);
  const analysis: ContentPreflightAnalysis = {
    ...analyzed.data,
    beats: policyApplied.beats.map((beat, index) => ({
      ...beat,
      beatKey: `window-${index}`,
      sourceExcerpt: windows[index].text,
      startMs: windows[index].startMs,
      endMs: windows[index].endMs,
    })),
  };
  const stored = await prisma.$transaction(async (tx) => {
    const raced = await tx.contentPreflight.findUnique({
      where: {
        projectId_sourceHash_analyzerVersion: {
          projectId: project.id,
          sourceHash,
          analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
        },
      },
      include: { visualBeats: true },
    });
    if (raced) return raced;
    const previous = await tx.contentPreflight.findFirst({
      where: input.previousPreflightId
        ? {
            id: input.previousPreflightId,
            projectId: project.id,
            userId: input.userId,
          }
        : {
            projectId: project.id,
            userId: input.userId,
            analyzerVersion: { in: [...COMPATIBLE_CONTENT_PREFLIGHT_ANALYZER_VERSIONS] },
          },
      orderBy: input.previousPreflightId ? undefined : { createdAt: "desc" },
      include: { visualBeats: true },
    });
    const preparedBeats = analysis.beats.map((beat) => ({
      beat,
      sourceExcerptHash: sourceWindowHash(beat.sourceExcerpt, sceneContentPolicy),
    }));
    const priorBeats = previous?.visualBeats.slice().sort((a, b) => a.sequence - b.sequence) ?? [];
    const usedPriorBeatIds = new Set<string>();
    const exactPriorBySequence = new Map<number, ProjectVisualBeat>();

    // Exact source windows are assigned first, independent of positional key.
    // Inserting/deleting one window therefore shifts sequences without losing
    // the assets for unchanged downstream windows.
    preparedBeats.forEach((prepared, sequence) => {
      const candidate = priorBeats
        .filter((prior) => !usedPriorBeatIds.has(prior.id)
          && storedSourceWindowHash(prior) === prepared.sourceExcerptHash)
        .sort((a, b) => Math.abs(a.sequence - sequence) - Math.abs(b.sequence - sequence))[0];
      if (!candidate) return;
      usedPriorBeatIds.add(candidate.id);
      exactPriorBySequence.set(sequence, candidate);
    });

    const fallbackPriorBySequence = new Map<number, ProjectVisualBeat>();
    preparedBeats.forEach((prepared, sequence) => {
      if (exactPriorBySequence.has(sequence)) return;
      const candidate = priorBeats.find((prior) =>
        !usedPriorBeatIds.has(prior.id)
        && (prior.beatKey === prepared.beat.beatKey || prior.sequence === sequence));
      if (!candidate) return;
      usedPriorBeatIds.add(candidate.id);
      fallbackPriorBySequence.set(sequence, candidate);
    });
    return tx.contentPreflight.create({
      data: {
        userId: input.userId,
        projectId: project.id,
        narrativeSourceKind: input.narrativeSource.kind,
        sourceHash,
        analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
        contentDomain: analysis.contentDomain,
        suggestedVisualFormatId: analysis.suggestedVisualFormatId,
        suggestedTreatmentJson: JSON.stringify(analysis.suggestedTreatment),
        visualBeats: {
          create: preparedBeats.map(({ beat, sourceExcerptHash }, sequence) => {
            const prior = exactPriorBySequence.get(sequence) ?? fallbackPriorBySequence.get(sequence);
            const sameExcerpt = exactPriorBySequence.has(sequence);
            const retainsAsset = Boolean(prior?.existingAssetUrl || prior?.existingImageJobId);
            const status = sameExcerpt
              ? (prior?.status ?? "current")
              : retainsAsset ? "outdated" : "current";
            return {
              userId: input.userId,
              projectId: project.id,
              beatKey: beat.beatKey,
              sequence,
              startMs: beat.startMs,
              endMs: beat.endMs,
              sourceExcerptHash,
              beatJson: JSON.stringify(beat),
              status,
              existingAssetUrl: prior?.existingAssetUrl,
              existingImageJobId: prior?.existingImageJobId,
              generationIdentityKey: prior?.generationIdentityKey,
              outdatedAt: status === "outdated" ? new Date() : prior?.outdatedAt,
            };
          }),
        },
      },
      include: { visualBeats: true },
    });
  });
  return resolved(stored, false);
}

/** Attach the latest generated asset to a Visual Beat. Completing an explicit
 * regeneration makes that beat current without touching sibling beats. */
export async function recordVisualBeatAsset(input: {
  userId: string;
  beatId: string;
  outputUrl: string;
  imageJobId: string;
  identityKey: string;
}): Promise<{ linked: boolean }> {
  const outputUrl = input.outputUrl.trim();
  if (!outputUrl) {
    throw new ContentPreflightError("INVALID_SOURCE", "ตำแหน่งภาพต้องไม่ว่าง");
  }
  try {
    return await linkCompletedVisualBeatAsset({ ...input, outputUrl });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not completed and settled")) {
      throw new ContentPreflightError("INVALID_SOURCE", error.message);
    }
    throw error;
  }
}

/** Current assets survive a Narrative Source edit when their exact beat excerpt
 * is unchanged. Hero rendering can reuse these rows and generate only new or
 * outdated beats after the creator confirms the next render. */
export async function reusableVisualBeatAssetsForVideoJob(input: {
  userId: string;
  videoJobId: string;
}): Promise<Array<{
  beatId: string;
  sceneIndex: number;
  outputUrl: string;
  imageJobId: string | null;
}>> {
  const job = await prisma.videoJob.findFirst({
    where: { id: input.videoJobId, userId: input.userId },
    select: { projectId: true, contentPreflightId: true, projectVisualContextJson: true },
  });
  if (!job?.projectId || !job.contentPreflightId || !job.projectVisualContextJson) return [];
  const preflight = await prisma.contentPreflight.findFirst({
    where: {
      userId: input.userId,
      projectId: job.projectId,
      id: job.contentPreflightId,
    },
    select: { id: true },
  });
  if (!preflight) return [];
  return reusableProjectVisualAssets({
    userId: input.userId,
    projectId: job.projectId,
    preflightId: preflight.id,
  });
}
