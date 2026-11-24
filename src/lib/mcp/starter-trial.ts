import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyEntitlement } from "@/lib/entitlements";
import { durationCapSecFor, isPaid } from "@/lib/plan-limits";
import { syncSharedUsageCycle } from "@/lib/usage-limits";
import { mcpAccessAllowed } from "@/lib/mcp/auth";
import { quoteFailure, type QuoteFailure } from "@/lib/mcp/video-quote";
import {
  buildMcpPlanRequiredUpgradeUrl,
  buildMcpUpgradeNext,
  MCP_PRO_UPGRADE_OFFER,
  MCP_UPGRADE_URL,
} from "@/lib/mcp/plan-upgrade-cta";
import type { PrepareVideoJobInput } from "@/lib/mcp/create-video-input";

export { MCP_UPGRADE_URL, buildMcpPlanRequiredUpgradeUrl, MCP_PRO_UPGRADE_OFFER };

export const MCP_STARTER_TRIAL_CLIP_LIMIT = 1;
export const MCP_STARTER_TRIAL_MAX_DURATION_SEC = durationCapSecFor("FREE");

export const MCP_PLAN_REQUIRED_MESSAGE =
  `ฟีเจอร์ MCP นี้ใช้ได้เฉพาะแผน PRO หรือ BUSINESS — แผนปัจจุบันยังเข้าถึงไม่ได้ อัปเกรดที่ ${MCP_UPGRADE_URL}`;

export const MCP_STARTER_TRIAL_EXHAUSTED_MESSAGE =
  `คุณใช้สิทธิ์ทดลองสร้างคลิปผ่าน MCP ครบ ${MCP_STARTER_TRIAL_CLIP_LIMIT} คลิปแล้ว — อัปเกรดเป็นแผน PRO หรือ BUSINESS เพื่อสร้างคลิปและแก้ไขต่อผ่าน MCP ได้ไม่จำกัดที่ ${MCP_UPGRADE_URL}`;

export const MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE =
  `สิทธิ์ทดลอง MCP (FREE 1 คลิป) รองรับเฉพาะคลิปพากย์เสียง Gemini + B-roll จากคลังภาพ/วิดีโอสต็อก ความยาวไม่เกิน 3 นาที (ไม่ใช้เครดิต) — หากต้องการใช้ Hero AI Image, เสียง ElevenLabs, Avatar หรือแก้ไขก่อนส่งออก อัปเกรดเป็นแผน PRO หรือ BUSINESS ที่ ${MCP_UPGRADE_URL}`;

export const MCP_UPGRADE_NEXT =
  `อัปเกรดเป็นแผน PRO หรือ BUSINESS ที่ ${MCP_UPGRADE_URL} แล้วลองใหม่`;

export const MCP_STARTER_TRIAL_ALLOWED_TOOLS = new Set<string>([
  "get_current_user",
  "get_video_options",
  "list_brand_profiles",
  "prepare_video_job",
  "get_video_quote",
  "create_video_job",
  "get_video_status",
  "cancel_video_job",
  "list_my_videos",
  "get_video",
  "download_video",
]);

export type McpStarterTrialStatus = {
  eligible: boolean;
  isStarterTrialPlan: boolean;
  usedClips: number;
  limitClips: number;
  remainingClips: number;
  maxDurationSeconds: number;
  allowedBrollSources: readonly ["stock"];
  allowedVoiceProviders: readonly ["gemini"];
  upgradeUrl: string;
};

export function isVerifiedMcpUser(
  user: Pick<User, "email" | "clerkId" | "googleId" | "suspended">,
): boolean {
  if (user.suspended) return false;
  return Boolean(
    (typeof user.clerkId === "string" && user.clerkId.trim().length > 0) ||
      (typeof user.googleId === "string" && user.googleId.trim().length > 0) ||
      (typeof user.email === "string" && user.email.includes("@")),
  );
}

export function isMcpStarterTrialEligibleUser(
  user: User,
  now: Date = new Date(),
): boolean {
  if (!isVerifiedMcpUser(user)) return false;
  if (user.planExpiresAt && user.planExpiresAt <= now) return false;
  if (user.trialEndsAt && user.trialEndsAt <= now) return false;
  if (user.trialEndedAt) return false;
  const entitlement = classifyEntitlement(user, now);
  if (entitlement.action !== "KEEP") return false;
  return entitlement.effectivePlan === "FREE";
}

export function canCreateMcpTokenForUser(
  user: User,
  now: Date = new Date(),
): boolean {
  const effectivePlan = classifyEntitlement(user, now).effectivePlan;
  if (isPaid(effectivePlan)) return true;
  return isMcpStarterTrialEligibleUser(user, now);
}

export function canInvokeMcpTool(
  user: User | undefined | null,
  effectivePlan: string | undefined | null,
  toolName: string,
  now: Date = new Date(),
): boolean {
  if (!user || !effectivePlan) return false;
  if (mcpAccessAllowed(effectivePlan)) return true;
  if (!isMcpStarterTrialEligibleUser(user, now)) return false;
  return MCP_STARTER_TRIAL_ALLOWED_TOOLS.has(toolName);
}

type VideoJobCountClient = Pick<Prisma.TransactionClient, "videoJob">;

export async function countStarterMcpRootJobsInTransaction(
  tx: VideoJobCountClient,
  userId: string,
): Promise<number> {
  const rows = await tx.videoJob.findMany({
    where: {
      userId,
      type: { in: ["create", "video"] },
      status: { notIn: ["failed", "canceled"] },
      fundingState: { not: "refunded" },
    },
    select: {
      id: true,
      budgetQuoteId: true,
      idempotencyKey: true,
    },
  });

  return rows.filter((row) => {
    const key = row.idempotencyKey ?? "";
    if (
      key.startsWith("mcp-chain:") ||
      key.startsWith("mcp-rerender:") ||
      key.startsWith("mcp-export:")
    ) {
      return false;
    }
    return Boolean(row.budgetQuoteId || key.startsWith("mcp-quote:") || key === "" || !key.startsWith("web:"));
  }).length;
}

export async function getMcpStarterTrialStatusInTransaction(
  tx: VideoJobCountClient,
  user: User,
  now: Date = new Date(),
): Promise<McpStarterTrialStatus> {
  const effectivePlan = classifyEntitlement(user, now).effectivePlan;
  const isStarterTrialPlan = !isPaid(effectivePlan);
  const eligible = isStarterTrialPlan && isMcpStarterTrialEligibleUser(user, now);
  const usedClips = isStarterTrialPlan
    ? await countStarterMcpRootJobsInTransaction(tx, user.id)
    : 0;
  const quotaAvailable =
    user.usageCount < user.usageLimit &&
    (process.env.MINUTE_QUOTA !== "1" || user.minutesUsed < user.minutesLimit);
  const remainingClips =
    eligible && quotaAvailable
      ? Math.max(0, MCP_STARTER_TRIAL_CLIP_LIMIT - usedClips)
      : 0;

  return {
    eligible: eligible && remainingClips > 0,
    isStarterTrialPlan,
    usedClips,
    limitClips: MCP_STARTER_TRIAL_CLIP_LIMIT,
    remainingClips,
    maxDurationSeconds: MCP_STARTER_TRIAL_MAX_DURATION_SEC,
    allowedBrollSources: ["stock"] as const,
    allowedVoiceProviders: ["gemini"] as const,
    upgradeUrl: MCP_UPGRADE_URL,
  };
}

export async function getMcpStarterTrialStatus(
  user: User,
  now: Date = new Date(),
): Promise<McpStarterTrialStatus> {
  return getMcpStarterTrialStatusInTransaction(prisma, user, now);
}

export function starterTrialPlanRequiredFailure(
  message: string,
  toolName?: string | null,
): QuoteFailure {
  const upgradeUrl = buildMcpPlanRequiredUpgradeUrl(toolName);
  const attributedMessage = message.includes(MCP_UPGRADE_URL)
    ? message.replaceAll(MCP_UPGRADE_URL, upgradeUrl)
    : `${message} อัปเกรดที่ ${upgradeUrl}`;
  return quoteFailure(
    "plan_required",
    attributedMessage,
    buildMcpUpgradeNext(upgradeUrl),
    { upgradeUrl, upgradeOffer: MCP_PRO_UPGRADE_OFFER },
  );
}

export async function validateMcpStarterTrialQuoteInput(
  user: User,
  input: PrepareVideoJobInput,
  durationSeconds: number,
  now: Date = new Date(),
  toolName: string = "prepare_video_job",
): Promise<QuoteFailure | null> {
  const effectivePlan = classifyEntitlement(user, now).effectivePlan;
  if (mcpAccessAllowed(effectivePlan)) return null;

  if (!isMcpStarterTrialEligibleUser(user, now)) {
    return starterTrialPlanRequiredFailure(MCP_PLAN_REQUIRED_MESSAGE, toolName);
  }

  const synced = await syncSharedUsageCycle(user.id, now);
  const usedClips = await countStarterMcpRootJobsInTransaction(prisma, user.id);
  if (usedClips >= MCP_STARTER_TRIAL_CLIP_LIMIT) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_EXHAUSTED_MESSAGE, toolName);
  }

  const currentUsageCount = synced?.usageCount ?? user.usageCount;
  const currentUsageLimit = synced?.usageLimit ?? user.usageLimit;
  if (currentUsageCount >= currentUsageLimit) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_EXHAUSTED_MESSAGE, toolName);
  }

  const neededMinutes = Math.max(1, Math.ceil(durationSeconds / 60));
  const currentMinutesUsed = synced?.minutesUsed ?? user.minutesUsed;
  const currentMinutesLimit = synced?.minutesLimit ?? user.minutesLimit;
  if (
    process.env.MINUTE_QUOTA === "1" &&
    currentMinutesUsed + neededMinutes > currentMinutesLimit
  ) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_EXHAUSTED_MESSAGE, toolName);
  }

  const source = input.brollSource ?? "stock";
  if (source !== "stock") {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  const voiceProvider =
    input.voiceProvider ?? (user.ttsProvider === "elevenlabs" ? "elevenlabs" : "gemini");
  if (voiceProvider !== "gemini") {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  if (input.avatarMode && input.avatarMode !== "none") {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  if (
    input.clipUrl ||
    input.clipUploadId ||
    (Array.isArray(input.clipUploadIds) && input.clipUploadIds.length > 0)
  ) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  if (input.exportMode === "hold") {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  if (durationSeconds > MCP_STARTER_TRIAL_MAX_DURATION_SEC) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  return null;
}

export async function validateMcpStarterTrialConsumptionInTransaction(
  tx: Prisma.TransactionClient,
  user: User,
  opts: {
    source: string;
    voiceProvider?: unknown;
    hasAvatar: boolean;
    hasPresenter: boolean;
    exportMode: "auto" | "hold";
    renderMinutesCeiling: number;
    totalHeroCreditCeiling: number;
    parentQuoteId: string | null;
  },
  now: Date = new Date(),
  toolName: string = "create_video_job",
): Promise<QuoteFailure | null> {
  const effectivePlan = classifyEntitlement(user, now).effectivePlan;
  if (mcpAccessAllowed(effectivePlan)) return null;

  if (!isMcpStarterTrialEligibleUser(user, now)) {
    return starterTrialPlanRequiredFailure(MCP_PLAN_REQUIRED_MESSAGE, toolName);
  }

  if (opts.parentQuoteId) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  const usedClips = await countStarterMcpRootJobsInTransaction(tx, user.id);
  if (usedClips >= MCP_STARTER_TRIAL_CLIP_LIMIT) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_EXHAUSTED_MESSAGE, toolName);
  }

  if (user.usageCount >= user.usageLimit) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_EXHAUSTED_MESSAGE, toolName);
  }

  if (
    process.env.MINUTE_QUOTA === "1" &&
    user.minutesUsed + opts.renderMinutesCeiling > user.minutesLimit
  ) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_EXHAUSTED_MESSAGE, toolName);
  }

  if (
    opts.source !== "stock" ||
    (opts.voiceProvider && opts.voiceProvider !== "gemini") ||
    opts.hasAvatar ||
    opts.hasPresenter ||
    opts.exportMode === "hold" ||
    opts.totalHeroCreditCeiling > 0 ||
    opts.renderMinutesCeiling > Math.ceil(MCP_STARTER_TRIAL_MAX_DURATION_SEC / 60)
  ) {
    return starterTrialPlanRequiredFailure(MCP_STARTER_TRIAL_FEATURE_LOCKED_MESSAGE, toolName);
  }

  return null;
}
