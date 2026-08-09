import "server-only";

export type BrandVisualRolloutPercent = 0 | 10 | 50 | 100;

export type BrandVisualRolloutFlags = {
  enabled: boolean;
  percent: BrandVisualRolloutPercent;
  startedAt: Date | null;
  testEmails: Set<string>;
};

export type BrandVisualAccessDecision = {
  canUse: boolean;
  cohort: "off" | "internal" | "control" | "treatment-10" | "treatment-50" | "treatment-100";
  bucket: number | null;
};

const PRODUCT_OWNER_EMAIL = "duckyhero@gmail.com";

function values(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function rolloutPercent(raw: string | undefined): BrandVisualRolloutPercent {
  const number = Number(raw);
  return number === 10 || number === 50 || number === 100 ? number : 0;
}

function rolloutDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const value = new Date(raw);
  return Number.isFinite(value.getTime()) ? value : null;
}

export function brandVisualRolloutFlags(env: NodeJS.ProcessEnv = process.env): BrandVisualRolloutFlags {
  return {
    enabled: env.BRAND_VISUAL_SYSTEM_ENABLED === "1",
    percent: rolloutPercent(env.BRAND_VISUAL_ROLLOUT_PERCENT),
    startedAt: rolloutDate(env.BRAND_VISUAL_ROLLOUT_STARTED_AT),
    testEmails: values(env.BRAND_VISUAL_TEST_EMAILS),
  };
}

/** Stable FNV-1a bucket. The salt isolates this experiment from other rollout
 * cohorts so expanding Brand Visual does not reshuffle any existing feature. */
export function brandVisualRolloutBucket(userId: string): number {
  let hash = 2166136261;
  const value = `brand-visual-v1:${userId}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function decideBrandVisualAccess(
  actor: { id: string; email?: string | null; role?: string | null; createdAt: Date },
  flags = brandVisualRolloutFlags(),
): BrandVisualAccessDecision {
  if (!flags.enabled) return { canUse: false, cohort: "off", bucket: null };
  const email = actor.email?.trim().toLowerCase() ?? "";
  if (actor.role === "ADMIN" || email === PRODUCT_OWNER_EMAIL || flags.testEmails.has(email)) {
    return { canUse: true, cohort: "internal", bucket: null };
  }
  const bucket = brandVisualRolloutBucket(actor.id);
  if (!flags.startedAt || actor.createdAt < flags.startedAt || flags.percent === 0) {
    return { canUse: false, cohort: "control", bucket };
  }
  const canUse = bucket < flags.percent;
  return {
    canUse,
    cohort: canUse ? `treatment-${flags.percent}` : "control",
    bucket,
  };
}
