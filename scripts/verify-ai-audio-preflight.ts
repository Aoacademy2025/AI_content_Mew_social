// Unit tests for the AI-audio ceiling preflight (HERO-25).
// Run: npx tsx scripts/verify-ai-audio-preflight.ts
//
// The managed AI-audio ceiling was only enforced INSIDE the pipeline, at
// /api/videos/tts-gemini and /api/videos/tts-omnivoice. A customer with no audio minutes
// left therefore waited through script and funding and only then collected a 429 written
// into VideoJob.errorMessage, with no CTA and nothing to stop the next attempt. On
// 2026-09-11 that was 7 of the 17 production create failures, from two accounts that had
// signed up that same morning; one of them pressed create five more times in fourteen
// minutes for five identical failures.
//
// This is the same class #301 already fixed once for plan x voice provider. The preflight
// added then covers the provider and deliberately nothing else, so the ceiling kept the
// old failure shape.
//
// Two rules with deliberately different strengths, matching the file they live in:
//  - managedAudioCeilingApplies is DETERMINISTIC (which engine spends managed minutes)
//  - the refusal itself fires only when the account has NO allowance left. It is never
//    built on an estimate of how long the script will be, because a duration gate built
//    on an estimator has misfired in this codebase before.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aiAudioCeilingRefusal,
  managedAudioCeilingApplies,
} from "../src/lib/render-plan-preflight";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const repoFile = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ── A. Which engines actually spend the managed ceiling ──
check("A1: managed Gemini narration spends it", managedAudioCeilingApplies("gemini", "managed"));
check("A2: BYOK Gemini does not", !managedAudioCeilingApplies("gemini", "byok"));
// Hero Voice is the platform's own worker (ADR 0003) and reserves with enforce:true
// unconditionally, so the Gemini key mode is irrelevant to it.
check("A3: Hero Voice always spends it", managedAudioCeilingApplies("omnivoice", "managed"));
check("A4: Hero Voice spends it under BYOK Gemini too", managedAudioCeilingApplies("omnivoice", "byok"));
// ElevenLabs narration is the customer's own key. The ceiling can still be reached later
// by an alignment transcribe, but every alignment layer fails OPEN (ADR 0056) — the clip
// renders without forced alignment. Refusing here would block a render that succeeds.
check("A5: ElevenLabs narration is not gated here", !managedAudioCeilingApplies("elevenlabs", "managed"));
check("A6: an uploaded clip runs no TTS at all", !managedAudioCeilingApplies("upload", "managed"));

// ── B. The refusal fires only on an exhausted ceiling ──
const exhausted = aiAudioCeilingRefusal(
  { allowed: false, used: 30, ceiling: 30, remaining: 0, message: "ใช้เสียง AI ครบเพดานรอบนี้แล้ว (Pro: 30 นาที/30 วัน)" },
  "PRO",
);
check("B1: an exhausted ceiling is refused", exhausted !== null);
check("B2: stable machine code", exhausted?.code === "QUOTA_AI_AUDIO");
check("B3: the refusal keeps the ceiling wording the pipeline already uses", (exhausted?.message ?? "").includes("เพดาน"));
check("B4: the refusal carries a way out", (exhausted?.userAction ?? "").length > 0);
check("B5: the way out names the reset, not only an upgrade", (exhausted?.userAction ?? "").includes("รอบถัดไป"));
check("B6: PRO is pointed at BUSINESS", exhausted?.neededPlan === "BUSINESS");

const business = aiAudioCeilingRefusal(
  { allowed: false, used: 160, ceiling: 160, remaining: 0, message: "ครบเพดาน" },
  "BUSINESS",
);
check("B7: the top tier is refused without inventing an upgrade", business !== null && business.neededPlan === null);

// ── C. Anything short of exhausted stays quiet ──
// The remaining allowance may be less than this script needs. That case must NOT be
// refused here: the only honest number for a script's audio length is the one the TTS
// step measures, and the pipeline reserve is still the authoritative gate.
check(
  "C1: allowance left means no refusal, however little",
  aiAudioCeilingRefusal({ allowed: true, used: 29.9, ceiling: 30, remaining: 0.1 }, "PRO") === null,
);
check(
  "C2: a fresh account is not refused",
  aiAudioCeilingRefusal({ allowed: true, used: 0, ceiling: 30, remaining: 30 }, "PRO") === null,
);
check(
  "C3: an unlimited (BYOK) ceiling is not refused",
  aiAudioCeilingRefusal(
    { allowed: true, used: 0, ceiling: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY },
    "PRO",
  ) === null,
);

// ── D. Both create paths must run the gate BEFORE a job row exists ──
for (const [label, path] of [
  ["web create", "src/app/api/videos/jobs/route.ts"],
  ["MCP create_video_job", "src/app/api/[transport]/route.ts"],
] as const) {
  const src = repoFile(path);
  check(`D (${label}): calls the ceiling preflight`, src.includes("managedAudioCeilingApplies("));
  check(`D (${label}): turns it into a refusal`, src.includes("aiAudioCeilingRefusal("));
  // The gate is worthless below the line that writes the row.
  const gateAt = src.indexOf("managedAudioCeilingApplies(");
  const createAt = src.lastIndexOf("createVideoJob(");
  check(
    `D (${label}): the gate runs before the VideoJob row is created`,
    gateAt !== -1 && createAt !== -1 && gateAt < createAt,
    `gate@${gateAt} create@${createAt}`,
  );
}

// ── E. The in-pipeline gate is still there ──
// This adds an earlier refusal; it never becomes the only one. A job that slips past the
// preflight (the allowance ran out between create and TTS) must still be stopped.
for (const path of [
  "src/app/api/videos/tts-gemini/route.ts",
  "src/app/api/videos/tts-omnivoice/route.ts",
]) {
  check(`E (${path.split("/").at(-2)}): still reserves against the ceiling`, repoFile(path).includes("reserveAiAudioMinutes("));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
