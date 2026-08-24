import { isTransientSqliteError } from "./sqlite-retry";

/** One persisted ERROR_SYSTEM per route inside this window. Hits after that stay in logs. */
export const ADMIN_ERROR_NOTIFY_WINDOW_MS = 5 * 60 * 1000;

const CAPACITY_MESSAGE =
  /socket timeout|database failed to respond|SQLITE_BUSY|SQLITE_LOCKED|timed out fetching a new connection|P1008|P2028|the database is locked/i;

export type AdminErrorNotifyStore = Map<string, { lastWriteAt: number; suppressed: number }>;

export type AdminErrorNotifyDecision =
  | { action: "write"; suppressed: number }
  | { action: "skip_capacity" }
  | { action: "skip_rate_limit"; suppressed: number };

const processStore: AdminErrorNotifyStore = new Map();

export function resetAdminErrorNotifyStoreForTests(): void {
  processStore.clear();
}

function prismaCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * SQLite / Prisma pool timeouts. Writing ERROR_SYSTEM for these is the
 * feedback loop from the 15–22 Aug audit: the timeout already means the DB
 * is overloaded, then notifyAdmins writes more rows.
 */
export function isCapacityError(error: unknown): boolean {
  if (isTransientSqliteError(error)) return true;
  const code = prismaCode(error);
  if (code === "P1008" || code === "P2028" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  return CAPACITY_MESSAGE.test(errorText(error));
}

export function decideAdminErrorNotify(input: {
  error: unknown;
  route: string;
  nowMs?: number;
  windowMs?: number;
  store?: AdminErrorNotifyStore;
}): AdminErrorNotifyDecision {
  if (isCapacityError(input.error)) return { action: "skip_capacity" };

  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? ADMIN_ERROR_NOTIFY_WINDOW_MS;
  const store = input.store ?? processStore;
  const key = input.route.trim() || "unknown";
  const entry = store.get(key);

  if (!entry || nowMs - entry.lastWriteAt >= windowMs) {
    const suppressed = entry?.suppressed ?? 0;
    store.set(key, { lastWriteAt: nowMs, suppressed: 0 });
    return { action: "write", suppressed };
  }

  entry.suppressed += 1;
  return { action: "skip_rate_limit", suppressed: entry.suppressed };
}
