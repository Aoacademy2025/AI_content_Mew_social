export type MediaWriteMode = "local" | "shadow" | "r2-required";
export type MediaReadMode = "local" | "local-r2" | "r2-local" | "r2";

export type MediaStorageRuntimeConfig = {
  writeMode: MediaWriteMode;
  readMode: MediaReadMode;
  localEvictionEnabled: boolean;
  r2DeleteEnabled: boolean;
  warnings: string[];
};

type MediaStorageEnvironment = Record<string, string | undefined>;

const WRITE_MODES: readonly MediaWriteMode[] = ["local", "shadow", "r2-required"];
const READ_MODES: readonly MediaReadMode[] = ["local", "local-r2", "r2-local", "r2"];

function safeMode<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  variable: string,
  warnings: string[],
): T {
  const value = raw?.trim();
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  warnings.push(`${variable}_invalid_defaulted_to_${fallback}`);
  return fallback;
}

/**
 * Fail-safe rollout configuration.
 *
 * Missing or invalid values preserve today's local-only behavior. Destructive
 * switches are gated by compatible read modes. Local eviction independently
 * verifies the catalog and R2 replica; R2 deletion still requires the final
 * remote-only write/read mode.
 */
export function mediaStorageRuntimeConfig(
  env: MediaStorageEnvironment = process.env,
): MediaStorageRuntimeConfig {
  const warnings: string[] = [];
  const writeMode = safeMode(
    env.MEDIA_WRITE_MODE,
    WRITE_MODES,
    "local",
    "MEDIA_WRITE_MODE",
    warnings,
  );
  const readMode = safeMode(
    env.MEDIA_READ_MODE,
    READ_MODES,
    "local",
    "MEDIA_READ_MODE",
    warnings,
  );

  const evictionRequested = env.MEDIA_LOCAL_EVICTION === "1";
  const localEvictionEnabled =
    evictionRequested &&
    (readMode === "r2-local" || readMode === "r2");
  if (evictionRequested && !localEvictionEnabled) {
    warnings.push("MEDIA_LOCAL_EVICTION_blocked_by_rollout_mode");
  }

  const deleteRequested = env.MEDIA_R2_DELETE === "1";
  const r2DeleteEnabled =
    deleteRequested &&
    writeMode === "r2-required" &&
    readMode === "r2" &&
    localEvictionEnabled;
  if (deleteRequested && !r2DeleteEnabled) {
    warnings.push("MEDIA_R2_DELETE_blocked_by_rollout_mode");
  }

  return {
    writeMode,
    readMode,
    localEvictionEnabled,
    r2DeleteEnabled,
    warnings,
  };
}
