/**
 * The one generic "something went wrong" Thai line the API layer falls back to when it can
 * say nothing more specific (`friendlyMessage` in `src/lib/api-error.ts`).
 *
 * Deliberately its own leaf module with ZERO imports: the MCP orchestrator has to RECOGNISE
 * this exact string (a route that answered with it carries no information, so the terminal
 * catch must replace it with the step prefix + failure code rather than store it verbatim),
 * and `src/lib/api-error.ts` pulls `clerk-auth.ts` → `@clerk/nextjs/server` / `next/headers`,
 * which breaks under the `--conditions=react-server` node flag several MCP verify scripts run
 * under. Import the constant from here, never from `@/lib/api-error`.
 */
export const GENERIC_ERROR_COPY = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
