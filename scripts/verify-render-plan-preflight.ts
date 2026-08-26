// Unit tests for the render plan preflight (#301).
// Run: npx tsx scripts/verify-render-plan-preflight.ts
//
// Two rules with deliberately different strengths:
//  - voiceProviderPlanViolation is DETERMINISTIC → both create paths must BLOCK on it.
//  - estimatedDurationPlanWarning is an ESTIMATE → it may only ever WARN. A duration gate
//    built on an estimator has misfired in this codebase before, so these tests pin it to
//    the same cap source as the authoritative post-TTS gate and nothing more.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimatedDurationPlanWarning,
  voiceProviderPlanViolation,
} from "../src/lib/render-plan-preflight";
import { audioDurationLimitViolation, durationCapSecFor } from "../src/lib/plan-limits";
import { buildReceipt, type ReceiptInput, type ReceiptModel } from "../src/app/(dashboard)/video-editor/_v2/receipt";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const repoFile = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ── A. Voice provider × plan — the rule that blocks ──
const freeEleven = voiceProviderPlanViolation("elevenlabs", "FREE");
check("A1: ElevenLabs on FREE is refused", freeEleven !== null);
check("A2: refusal names the provider", (freeEleven?.message ?? "").includes("ElevenLabs"));
check("A3: refusal carries a way out (userAction)", (freeEleven?.userAction ?? "").length > 0);
check("A4: refusal offers the free alternative by name", (freeEleven?.userAction ?? "").includes("Gemini"));
check("A5: refusal points at PRO", freeEleven?.neededPlan === "PRO");
check("A6: stable machine code", freeEleven?.code === "voice_plan_required");

check("A7: ElevenLabs on PRO passes", voiceProviderPlanViolation("elevenlabs", "PRO") === null);
check("A8: ElevenLabs on BUSINESS passes", voiceProviderPlanViolation("elevenlabs", "BUSINESS") === null);
check("A9: Gemini on FREE passes", voiceProviderPlanViolation("gemini", "FREE") === null);
check("A10: Hero Voice on FREE is not gated here", voiceProviderPlanViolation("omnivoice", "FREE") === null);
check("A11: missing provider defaults to the free engine", voiceProviderPlanViolation(null, "FREE") === null);
check("A12: unknown provider is not invented into a paywall", voiceProviderPlanViolation("something-else", "FREE") === null);

// ── B. Duration estimate — the rule that only warns ──
const freeCap = durationCapSecFor("FREE");
check("B1: under the cap says nothing", estimatedDurationPlanWarning(freeCap - 1, "FREE") === null);
check("B2: exactly at the cap says nothing", estimatedDurationPlanWarning(freeCap, "FREE") === null);
const overFree = estimatedDurationPlanWarning(freeCap + 30, "FREE");
check("B3: over the cap warns", overFree !== null);
check("B4: warning quotes the plan's own cap", overFree?.capSec === freeCap);
check("B5: warning offers trim or upgrade", (overFree?.userAction ?? "").includes("อัปเกรด"));
check("B6: warning says what happens if they render anyway", (overFree?.userAction ?? "").includes("หยุด"));
check("B7: zero/unknown duration says nothing", estimatedDurationPlanWarning(0, "FREE") === null);
check("B8: NaN says nothing", estimatedDurationPlanWarning(Number.NaN, "FREE") === null);
const overBusiness = estimatedDurationPlanWarning(durationCapSecFor("BUSINESS") + 60, "BUSINESS");
check("B9: top tier warns without an upgrade CTA", overBusiness !== null && overBusiness.neededPlan === null);

// The warning must agree with the authoritative gate: same cap, same direction. If the
// estimate were exact, anything this warns about would also fail the real gate.
for (const plan of ["FREE", "PRO", "BUSINESS"]) {
  const cap = durationCapSecFor(plan);
  const warned = estimatedDurationPlanWarning(cap + 5, plan) !== null;
  const gated = audioDurationLimitViolation((cap + 5) * 1000, plan) !== null;
  check(`B10 (${plan}): warning and post-TTS gate agree on the cap`, warned === gated);
  const quiet = estimatedDurationPlanWarning(cap - 5, plan) === null;
  const passes = audioDurationLimitViolation((cap - 5) * 1000, plan) === null;
  check(`B11 (${plan}): both stay quiet under the cap`, quiet === passes);
}

// ── C. Receipt integration — the warning has to actually reach the confirm dialog ──
const base: ReceiptInput = {
  estSec: 60,
  remainingMinutes: 10,
  totalMinutes: 10,
  usesAi: false,
  presetWeights: { video: 3, photo: 2, ai: 1 },
  perImageCredits: 3,
  creditBalance: 100,
  minuteCreditRate: 2,
  hasAvatar: false,
};
const R = (o: Partial<ReceiptInput>) => buildReceipt({ ...base, ...o });
const has = (m: ReceiptModel, k: string) => m.lines.some((l) => l.key === k);
const last = (m: ReceiptModel) => m.lines[m.lines.length - 1].key;

const overCapReceipt = R({ estSec: freeCap + 60, plan: "FREE" });
check("C1: over-cap script warns in the receipt", has(overCapReceipt, "duration-over-plan"));
check("C2: the line is a warning, not an error", overCapReceipt.lines.find((l) => l.key === "duration-over-plan")?.kind === "warn");
check("C3: disclaimer stays last", last(overCapReceipt) === "disclaimer");
check("C4: no plan → receipt unchanged", !has(R({ estSec: freeCap + 60 }), "duration-over-plan"));
check("C5: within cap → no line", !has(R({ estSec: 60, plan: "FREE" }), "duration-over-plan"));
check("C6: PRO is not warned about a FREE-sized script", !has(R({ estSec: freeCap + 60, plan: "PRO" }), "duration-over-plan"));
check(
  "C7: uploaded clip (exact duration) is gated in Step 1, not warned here",
  !has(R({ estSec: freeCap + 60, plan: "FREE", exactDuration: true }), "duration-over-plan"),
);
// The dialog disables its CTA on these two keys only — the advisory line must not join them.
check(
  "C8: the warning does not block the render CTA",
  !overCapReceipt.lines.some((l) => l.key === "insufficient" || l.key === "allowance-insufficient"),
);

// ── D. Both create paths must still run the deterministic gate ──
for (const [label, path] of [
  ["web create", "src/app/api/videos/jobs/route.ts"],
  ["MCP create_video_job", "src/app/api/[transport]/route.ts"],
] as const) {
  const src = repoFile(path);
  check(`D (${label}): imports the preflight`, src.includes("render-plan-preflight"));
  check(`D (${label}): calls voiceProviderPlanViolation`, src.includes("voiceProviderPlanViolation("));
}
// The dialog CTA logic reads `p.plan`; without it the receipt silently loses the warning.
check(
  "D: RenderReceiptDialog passes the plan through",
  /plan:\s*p\.plan/.test(repoFile("src/app/(dashboard)/video-editor/_v2/RenderReceiptDialog.tsx")),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
