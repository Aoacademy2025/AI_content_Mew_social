export function isTransientSqliteError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "P1008" || code === "P2028";
}

export async function withTransientSqliteRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
    onRetry?: (input: { attempt: number; delayMs: number; error: unknown }) => void;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 50));
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientSqliteError(error) || attempt >= maxAttempts) throw error;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
