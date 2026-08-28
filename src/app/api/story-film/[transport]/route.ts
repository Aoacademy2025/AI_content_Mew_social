import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { User } from "@prisma/client";
import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { z } from "zod";
import {
  resolveMcpPrincipal,
  resolveMcpPrincipalByClerkId,
  type McpPrincipal,
} from "@/lib/mcp/auth";
import { isInBandError, recordToolCall } from "@/lib/mcp/audit";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import {
  decideStoryFilm,
  readStoryFilm,
  startStoryFilm,
  StoryFilmError,
  type StoryFilmProjectView,
} from "@/lib/story-film.server";

export const runtime = "nodejs";

const PUBLIC_ORIGIN = "https://studio.heroaiengine.com";
const INTERNAL_INSTRUCTIONS = `Hero Story Film internal control plane for Mew and the Mew Social team only.
Use hero_story_film_start once, hero_story_film_read before every decision, and hero_story_film_decide with the exact stage and revision just read.
Never infer an approval, never approve a gate without a Hero review link, and never call the public create_video_job tool as a fallback.
Final Render has two gates: approve the music/editorial setup to create a preview, then review the actual preview before decision=render.
When status is needs_attention, use decision=retry only after Mew explicitly approves retrying the same failed jobs.
Use final_render revise with sceneKeys and repairLayer to repair only selected B-roll scenes; music/editorial-only revisions must leave visual assets intact.`;

function absoluteReviewUrl(value: string): string {
  const origin = process.env.MCP_PUBLIC_ORIGIN?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || PUBLIC_ORIGIN;
  return new URL(value, origin).toString();
}

function publicProject(project: StoryFilmProjectView): StoryFilmProjectView {
  return { ...project, reviewUrl: absoluteReviewUrl(project.reviewUrl) };
}

function publicReadResult(result: Awaited<ReturnType<typeof readStoryFilm>>) {
  if (result.kind === "project") return { ...result, project: publicProject(result.project) };
  if (result.kind === "candidates") return { ...result, candidates: result.candidates.map(publicProject) };
  return result;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

type Extra = { authInfo?: AuthInfo };
function principalFrom(extra: Extra) {
  const data = (extra.authInfo?.extra ?? {}) as { userId?: string; user?: User };
  return { userId: data.userId, user: data.user };
}

async function runInternalTool(
  toolName: string,
  extra: Extra,
  args: unknown,
  fn: (principal: { userId: string; user: User }) => Promise<unknown>,
) {
  const startedAt = Date.now();
  const principal = principalFrom(extra);
  if (!principal.userId || !principal.user || !isInternalAiTester(principal.user)) {
    await recordToolCall({
      userId: principal.userId,
      toolName,
      status: "denied",
      durationMs: Date.now() - startedAt,
      requestJson: args,
    });
    return text({ error: "not_found", message: "ไม่พบเครื่องมือนี้" });
  }
  try {
    const result = await fn({ userId: principal.userId, user: principal.user });
    await recordToolCall({
      userId: principal.userId,
      toolName,
      status: isInBandError(result) ? "error" : "ok",
      durationMs: Date.now() - startedAt,
      requestJson: args,
    });
    return text(result);
  } catch (error) {
    const payload = error instanceof StoryFilmError
      ? { error: error.code, message: error.message, current: error.current ? publicProject(error.current) : undefined }
      : { error: "internal_error", message: "เกิดข้อผิดพลาดภายใน ลองใหม่อีกครั้ง" };
    await recordToolCall({
      userId: principal.userId,
      toolName,
      status: "error",
      durationMs: Date.now() - startedAt,
      requestJson: args,
    });
    return text(payload);
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "hero_story_film_start",
      {
        title: "Start Hero Story Film",
        description: "สร้างหรือ resume Hero Story Film Project แบบ idempotent สำหรับ workflow ภายใน",
        inputSchema: {
          title: z.string().min(1).max(120),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
          presentationMode: z.enum(["presenter_led", "faceless"]),
          sourcePackage: z.string().max(500).optional(),
          narrativeSource: z.string().min(10).max(12_000),
          presenterAssetId: z.string().max(120).optional(),
          narrationProvider: z.enum(["hero_voice", "elevenlabs"]).optional(),
          narrationVoiceId: z.string().max(160).optional(),
          narrationVoiceSpeed: z.number().min(0.3).max(3).optional(),
          characterProfileId: z.string().max(120).optional(),
          characterLookBrief: z.string().max(1_000).optional(),
          aspectRatio: z.literal("9:16").default("9:16"),
        },
      },
      async (args, extra) => runInternalTool("hero_story_film_start", extra, args, async (principal) => {
        const result = await startStoryFilm(principal.userId, args);
        return { ...result, project: publicProject(result.project) };
      }),
    );

    server.registerTool(
      "hero_story_film_read",
      {
        title: "Read Hero Story Film",
        description: "อ่าน stage, revision, review link และการตัดสินใจที่อนุญาตของโปรเจกต์",
        inputSchema: {
          projectId: z.string().min(1).optional(),
          latestEligible: z.boolean().default(false),
        },
      },
      async (args, extra) => runInternalTool("hero_story_film_read", extra, args, async (principal) => {
        const result = args.projectId
          ? await readStoryFilm(principal.userId, { projectId: args.projectId })
          : await readStoryFilm(principal.userId, { latestEligible: true });
        return publicReadResult(result);
      }),
    );

    server.registerTool(
      "hero_story_film_decide",
      {
        title: "Decide Hero Story Film gate",
        description: "ส่งการตัดสินใจหนึ่งรายการโดยผูกกับ stage และ revision ที่อ่านล่าสุด",
        inputSchema: {
          projectId: z.string().min(1),
          expectedStage: z.enum(["setup", "narration", "storyboard", "character_look", "keyframes", "videos", "music", "final_render", "completed"]),
          expectedRevision: z.number().int().positive(),
          decision: z.enum(["approve", "revise", "reroll", "fallback", "pause", "resume", "retry", "render"]),
          instruction: z.string().max(2_000).optional(),
          target: z.object({
            sceneKey: z.string().regex(/^scene-\d{2}$/u).optional(),
            videoSceneKeys: z.array(z.string().regex(/^scene-\d{2}$/u)).max(60).optional(),
            sceneKeys: z.array(z.string().regex(/^scene-\d{2}$/u)).max(60).optional(),
            repairLayer: z.enum(["keyframe", "video"]).optional(),
            musicSource: z.enum(["user", "system"]).optional(),
            musicTrackId: z.string().optional(),
            editorial: z.object({
              subtitlesEnabled: z.boolean(),
              subtitleMode: z.enum(["sentence", "1", "2", "3", "4"]),
              subtitleStylePreset: z.enum(["stroke", "classic-yellow", "bold-shadow", "box-rounded", "news"]),
              subtitleTextEffect: z.enum(["pop", "fade", "quick", "highlight", "karaoke", "typewriter"]),
              subtitlePosition: z.enum(["top", "middle", "bottom"]),
              subtitleFontFamily: z.enum(["Kanit", "Prompt", "Sarabun", "Mitr", "Noto Sans Thai"]),
              subtitleFontSize: z.number().int().min(44).max(96).optional(),
              subtitleFontWeight: z.union([
                z.literal(400), z.literal(500), z.literal(600),
                z.literal(700), z.literal(800), z.literal(900),
              ]).optional(),
              headlineHook: z.object({
                enabled: z.boolean(),
                headline: z.string().max(64),
                subheadline: z.string().max(90).optional(),
                durationMs: z.number().int().min(3_000).max(20_000),
                preset: z.enum(["viral", "news", "clean"]),
                topPercent: z.number().int().min(10).max(42),
                fontFamily: z.enum(["Kanit", "Prompt", "Sarabun", "Mitr", "Noto Sans Thai"]).optional(),
                fontSize: z.number().int().min(52).max(120).optional(),
                fontWeight: z.union([z.literal(400), z.literal(600), z.literal(900)]).optional(),
                subheadlineFontSize: z.number().int().min(32).max(88).optional(),
              }),
              textOverlays: z.array(z.object({
                sceneKey: z.string().regex(/^scene-\d{2}$/u),
                text: z.string().min(1).max(240),
              })).max(60),
            }).optional(),
            visualQa: z.object({
              anatomy: z.boolean(),
              spatialDirection: z.boolean(),
              continuity: z.boolean(),
              generatedText: z.boolean(),
            }).optional(),
          }).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/).optional(),
        },
      },
      async (args, extra) => runInternalTool("hero_story_film_decide", extra, args, async (principal) => {
        const project = await decideStoryFilm(principal.userId, args);
        return { project: publicProject(project) };
      }),
    );
  },
  {
    serverInfo: { name: "hero-story-film-internal", version: "0.1.0" },
    capabilities: { tools: {} },
    instructions: INTERNAL_INSTRUCTIONS,
  },
  {
    basePath: "/api/story-film",
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV === "development",
  },
);

function principalAuthInfo(bearerToken: string, principal: McpPrincipal): AuthInfo {
  return {
    token: bearerToken,
    scopes: ["heroai:story-film:internal"],
    clientId: principal.userId,
    extra: {
      userId: principal.userId,
      plan: principal.plan,
      effectivePlan: principal.effectivePlan,
      user: principal.user,
    },
  };
}

const verifyInternalToken = async (_request: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  const patPrincipal = await resolveMcpPrincipal(bearerToken);
  if (patPrincipal && isInternalAiTester(patPrincipal.user)) {
    return principalAuthInfo(bearerToken!, patPrincipal);
  }

  try {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    const verified = await verifyClerkToken(clerkAuth, bearerToken);
    if (verified) {
      const clerkUserId = (verified.extra as { userId?: string } | undefined)?.userId ?? verified.clientId;
      const principal = await resolveMcpPrincipalByClerkId(clerkUserId);
      if (principal && isInternalAiTester(principal.user)) {
        return principalAuthInfo(bearerToken!, principal);
      }
    }
  } catch {
    // Invalid, non-internal, or non-OAuth token: fail closed before tools/list.
  }
  return undefined;
};

const authHandler = withMcpAuth(handler, verifyInternalToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
