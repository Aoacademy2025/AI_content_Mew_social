import { z } from "zod";
import { GEMINI_VOICES } from "@/lib/gemini-voices";

const GEMINI_VOICE_IDS = GEMINI_VOICES.map((voice) => voice.id) as [
  (typeof GEMINI_VOICES)[number]["id"],
  ...(typeof GEMINI_VOICES)[number]["id"][],
];

/** Public create_video_job input contract shared by MCP registration and tests. */
export const createVideoJobInputShape = {
  script: z.string().min(1).max(20000),
  title: z.string().max(200).optional(),
  voiceProvider: z.enum(["gemini", "elevenlabs"]).optional(),
  voiceId: z.string().optional(),
  geminiVoiceName: z.enum(GEMINI_VOICE_IDS).optional(),
  avatarMode: z.enum(["none", "full", "bookend", "bookend-both"]).optional(),
  avatarId: z.string().optional(),
  avatarIntroSecs: z.number().int().min(1).max(30).optional(),
  avatarTailSecs: z.number().int().min(1).max(30).optional(),
  avatarScale: z.number().min(0.1).max(2.5).optional(),
  avatarOffsetX: z.number().min(-2).max(2).optional(),
  avatarOffsetY: z.number().min(-2).max(2).optional(),
  bgmFile: z.string().optional(),
  bgmVolume: z.number().min(0).max(1).optional(),
  subtitleMode: z.enum(["sentence", "1", "2", "3", "4"]).optional(),
  subtitlePosition: z.enum(["top", "middle", "bottom"]).optional(),
  idempotencyKey: z.string().max(120).optional(),
} satisfies z.ZodRawShape;

export const createVideoJobInputSchema = z.object(createVideoJobInputShape);
export type CreateVideoJobInput = z.infer<typeof createVideoJobInputSchema>;
