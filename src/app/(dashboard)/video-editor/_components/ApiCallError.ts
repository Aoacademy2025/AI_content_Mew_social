export class ApiCallError extends Error {
  data: Record<string, unknown>;
  constructor(prefix: string, data: Record<string, unknown>, status?: number) {
    const detail = data.detail ? ` — ${String(data.detail).slice(0, 200)}` : "";
    super(`${prefix}: ${data.error ?? "Unknown error"}${detail}`);
    this.data = { ...data, _status: status };
  }
}
