import { readFileSync } from "node:fs";
import { captionsFromSpokenScript, captionsFromTtsTiming } from "../src/app/(dashboard)/video-editor/_components/tts-timing-captions";
import { subtitleQualityShouldFailJob, validateSubtitleQuality } from "../src/lib/mcp/subtitle-quality";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}`);
  }
}

const script = "ประหยัดเงินทุกเดือนด้วยวิธีนี้ แล้วเริ่มวันนี้";
const spoken = captionsFromSpokenScript(script, 8_000, 24);
check("Avatar last-resort builder returns captions", Boolean(spoken && spoken.captions.length > 0));
check("last-resort text is the exact script", spoken?.fullText === script);
check(
  "last card ends at audio duration",
  spoken?.captions.at(-1)?.endMs === 8_000,
);

const qa = spoken
  ? validateSubtitleQuality({
      script,
      captions: spoken.captions,
      audioDurationMs: spoken.audioDurationMs,
      timingSource: "avatar_script_clock",
    })
  : null;
check(
  "estimated Avatar script clock is reported as unverified, not rejected (ADR 0056)",
  qa?.status === "warning" && qa.code === "unverified_alignment" && !subtitleQualityShouldFailJob(qa),
);

check(
  "faceless still refuses to invent captions from missing provider timing",
  captionsFromTtsTiming(undefined, 8_000, 24) === null,
);

const orchestrator = readFileSync("src/lib/mcp/orchestrator.ts", "utf8");
check(
  "Avatar recovery transcribes TTS voice, not the HeyGen mp4",
  /audioUrl: tts\.voiceUrl/.test(orchestrator) && !/transcribe[\s\S]{0,400}avatarVideoUrl/.test(orchestrator),
);
// ADR 0056: the char-proportional spoken-script clock is the LAST rung of the timing
// ladder — reached only when the provider returned no usable timing, and always reported
// as avatar_script_clock so it can never masquerade as measured timing.
check(
  "the spoken-script clock is the last rung of the timing ladder (ADR 0056)",
  /capRes = captionsFromSpokenScript\(narrationText[\s\S]{0,200}subtitleTimingSource = "avatar_script_clock";/.test(orchestrator),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-avatar-caption-fallback: PASS");
