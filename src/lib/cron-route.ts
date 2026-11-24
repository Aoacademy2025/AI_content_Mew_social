import { timingSafeStrEqual } from "./timing-safe-equal";

export type CronJobOk = { status: 200; body: { ok: true } & Record<string, unknown> };
export type CronJobUnauthorized = { status: 401; body: { error: "Unauthorized" } };
export type CronJobConflict = {
  status: 409;
  body: { ok: false; error: "cron_already_running"; name: string };
};
export type CronJobFailed = { status: 503; body: { ok: false; error: "cron_failed" } };
export type CronJobResult = CronJobOk | CronJobUnauthorized | CronJobConflict | CronJobFailed;

const ACTIVE_CRON_JOBS_KEY = "__heroActiveCronJobs";

function getActiveCronJobs(): Set<string> {
  const globalStore = globalThis as typeof globalThis & {
    [ACTIVE_CRON_JOBS_KEY]?: Set<string>;
  };
  if (!globalStore[ACTIVE_CRON_JOBS_KEY]) {
    globalStore[ACTIVE_CRON_JOBS_KEY] = new Set<string>();
  }
  return globalStore[ACTIVE_CRON_JOBS_KEY];
}

/**
 * Shared cron GET body. Auth fails closed. An overlapping request for an
 * already-running job returns 409 immediately instead of stacking concurrent
 * SQLite sweeps. A thrown run (Prisma socket timeout included) becomes 503
 * instead of an unhandled route error, so Sentry/LINE do not open a new group
 * per retry. Heartbeat is success-only.
 */
export async function runAuthorizedCronJob(input: {
  authorization: string | null;
  secret: string | undefined;
  name: string;
  run: () => Promise<Record<string, unknown>>;
  onSuccess?: (name: string) => void;
  logError?: (name: string, error: unknown) => void;
}): Promise<CronJobResult> {
  const secret = input.secret;
  if (!secret || !timingSafeStrEqual(input.authorization ?? "", `Bearer ${secret}`)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }

  const activeJobs = getActiveCronJobs();
  if (activeJobs.has(input.name)) {
    return {
      status: 409,
      body: { ok: false, error: "cron_already_running", name: input.name },
    };
  }

  activeJobs.add(input.name);
  try {
    const result = await input.run();
    input.onSuccess?.(input.name);
    return { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    const log = input.logError ?? ((name, err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${name}] failed:`, message);
    });
    log(input.name, error);
    return { status: 503, body: { ok: false, error: "cron_failed" } };
  } finally {
    activeJobs.delete(input.name);
  }
}
