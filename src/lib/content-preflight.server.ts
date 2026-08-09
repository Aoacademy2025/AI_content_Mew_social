import { createHash } from "node:crypto";
import type { ContentPreflight, ProjectVisualBeat } from "@prisma/client";
import { z } from "zod";
import { VISUAL_FORMAT_IDS, type VisualFormatId } from "@/lib/brand-visual-system";
import { prisma } from "@/lib/prisma";
import { geminiGenerateText } from "@/lib/gemini";
import { KeyRequiredError, resolveGeminiKey } from "@/lib/gemini-key";
import { reserveAiTextCall } from "@/lib/ai-text-limits";

export const CONTENT_PREFLIGHT_ANALYZER_VERSION = "brand-content-preflight-v1";
export type NarrativeSourceKind = "ai-script" | "creator-script" | "upload-transcript";

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
  cached: boolean;
};

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
export function createGeminiContentPreflightAnalyzer(userId: string): ContentPreflightAnalyzer {
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

      const raw = await geminiGenerateText(key, [
        "Analyze this Narrative Source for a vertical short-form video.",
        "Return one JSON object only. Do not wrap it in markdown.",
        `sourceKind: ${input.kind}`,
        "Choose suggestedVisualFormatId from: cinematic-realism, stick-figure-story, dramatic-comic, clear-infographic, retro-story.",
        "Break the source into stable sequential visual beats. Use beatKey window-0, window-1, and so on.",
        "Each beat must describe one text-free frozen visual moment, not a montage and not typography.",
        "Schema: {contentDomain:string,suggestedVisualFormatId:string,suggestedTreatment:{label:string,mood:string},beats:[{beatKey:string,sourceExcerpt:string,startMs?:integer,endMs?:integer,subject:string,action:string,setting:string,emotion:string,emphasis:string}]}",
        "Narrative Source:",
        input.text,
      ].join("\n"), 8_192, 0.2);
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

export function contentPreflightSourceHash(kind: NarrativeSourceKind, text: string): string {
  return createHash("sha256")
    .update(`${kind}\0${normalizedNarrative(text)}`)
    .digest("hex");
}

function excerptHash(excerpt: string): string {
  return createHash("sha256").update(normalizedNarrative(excerpt)).digest("hex");
}

type StoredPreflight = ContentPreflight & { visualBeats: ProjectVisualBeat[] };

function resolved(row: StoredPreflight, cached: boolean): ResolvedContentPreflight {
  const treatment = JSON.parse(row.suggestedTreatmentJson) as ContentPreflightAnalysis["suggestedTreatment"];
  return {
    id: row.id,
    sourceHash: row.sourceHash,
    contentDomain: row.contentDomain,
    suggestedVisualFormatId: row.suggestedVisualFormatId as VisualFormatId,
    suggestedTreatment: treatment,
    visualBeats: row.visualBeats
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((beat) => ({
        ...(JSON.parse(beat.beatJson) as ContentPreflightAnalysis["beats"][number]),
        id: beat.id,
        status: beat.status,
        existingAssetUrl: beat.existingAssetUrl,
      })),
    cached,
  };
}

/** Resolve once per normalized Narrative Source and analyzer version. The
 * external analyzer sits behind an injected port; persistence and callers see
 * only the structured Content Preflight interface. */
export async function resolveContentPreflight(input: {
  userId: string;
  projectId: string;
  narrativeSource: { kind: NarrativeSourceKind; text: string };
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
  const sourceHash = contentPreflightSourceHash(input.narrativeSource.kind, text);
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
  if (cached) return resolved(cached, true);
  if (!input.analyzer) {
    throw new ContentPreflightError("ANALYZER_UNAVAILABLE", "ยังไม่ได้เชื่อมตัววิเคราะห์เนื้อหา");
  }

  const analyzed = analysisSchema.safeParse(await input.analyzer.analyze({
    kind: input.narrativeSource.kind,
    text,
  }));
  if (!analyzed.success) {
    throw new ContentPreflightError(
      "INVALID_ANALYSIS",
      analyzed.error.issues[0]?.message || "ผลวิเคราะห์เนื้อหาไม่ครบ",
    );
  }
  const analysis = analyzed.data;
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
      where: {
        projectId: project.id,
        analyzerVersion: CONTENT_PREFLIGHT_ANALYZER_VERSION,
      },
      orderBy: { createdAt: "desc" },
      include: { visualBeats: true },
    });
    const previousByKey = new Map(
      previous?.visualBeats.map((beat) => [beat.beatKey, beat]) ?? [],
    );
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
          create: analysis.beats.map((beat, sequence) => {
            const sourceExcerptHash = excerptHash(beat.sourceExcerpt);
            const prior = previousByKey.get(beat.beatKey);
            const sameExcerpt = prior?.sourceExcerptHash === sourceExcerptHash;
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
  imageJobId?: string;
}): Promise<void> {
  const outputUrl = input.outputUrl.trim();
  if (!outputUrl) {
    throw new ContentPreflightError("INVALID_SOURCE", "ตำแหน่งภาพต้องไม่ว่าง");
  }
  const beat = await prisma.projectVisualBeat.findFirst({
    where: { id: input.beatId, userId: input.userId },
    select: { id: true },
  });
  if (!beat) throw new ContentPreflightError("NOT_FOUND", "ไม่พบ Visual Beat นี้");
  await prisma.projectVisualBeat.update({
    where: { id: beat.id },
    data: {
      existingAssetUrl: outputUrl,
      existingImageJobId: input.imageJobId ?? null,
      status: "current",
      outdatedAt: null,
    },
  });
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
    select: { projectId: true },
  });
  if (!job?.projectId) return [];
  const preflight = await prisma.contentPreflight.findFirst({
    where: { userId: input.userId, projectId: job.projectId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!preflight) return [];
  const beats = await prisma.projectVisualBeat.findMany({
    where: {
      userId: input.userId,
      preflightId: preflight.id,
      status: "current",
      existingAssetUrl: { not: null },
    },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      sequence: true,
      existingAssetUrl: true,
      existingImageJobId: true,
    },
  });
  return beats.flatMap((beat) => beat.existingAssetUrl ? [{
    beatId: beat.id,
    sceneIndex: beat.sequence,
    outputUrl: beat.existingAssetUrl,
    imageJobId: beat.existingImageJobId,
  }] : []);
}
