import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CHECKPOINT_SUBTITLE_TIMING_SOURCES,
  parseAvatarProviderCheckpoint,
  serializeAvatarProviderCheckpoint,
} from "../src/lib/mcp/avatar-provider-checkpoint";
import type { SubtitleTimingSource } from "../src/lib/mcp/subtitle-quality";

/**
 * A checkpoint in the exact shape production writes at `intro_wait`: the phase
 * where HeyGen has already generated and billed the intro video, so a parse
 * failure here costs the customer money as well as the render.
 */
function checkpointAt(timingSource?: SubtitleTimingSource) {
  return {
    version: 1 as const,
    provider: "heygen" as const,
    phase: "intro_wait" as const,
    providerStartedAt: "2026-09-09T15:37:51.724Z",
    providerDeadlineAt: "2026-09-09T17:37:51.724Z",
    baseUrl: "/api/renders/render-1.mp4",
    voiceUrl: "/api/renders/tts-1.wav",
    audioDurationMs: 98073,
    captions: [{ text: "หนึ่ง", startMs: 0, endMs: 900 }],
    words: [],
    fullText: "หนึ่ง",
    ...(timingSource ? { subtitleTimingSource: timingSource } : {}),
    speechCoverage: { source: "silence_analysis" as const, spokenEndMs: 98170 },
    baseConfig: {},
    avatar: {
      mode: "bookend" as const,
      id: "dbede938f9ca4e1fb3a299af94effe89",
      introSecs: 5,
      tailSecs: 5,
      layout: { scale: 1, offsetX: 0, offsetY: 0 },
      introAudioUrl: "/api/renders/tts-trimmed-1.wav",
      introVideoId: "05ec14ca3b424c6fae15c4d03e2ee6a7",
    },
  };
}

async function main() {
  // ---- the union and the allowlist can never drift apart ----------------
  // The Record is typed `Record<SubtitleTimingSource, true>`, so a missing
  // member is already a compile error. This asserts the runtime half: the
  // parser really does accept every one of them.
  const declared = Object.keys(CHECKPOINT_SUBTITLE_TIMING_SOURCES) as SubtitleTimingSource[];
  assert.ok(declared.length >= 7, "the timing-source union should not have shrunk unnoticed");

  const source = fs.readFileSync("src/lib/mcp/subtitle-quality.ts", "utf8");
  const union = source.slice(
    source.indexOf("export type SubtitleTimingSource"),
    source.indexOf(";", source.indexOf("export type SubtitleTimingSource")),
  );
  const inUnion = [...union.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    [...declared].sort(),
    inUnion,
    "every SubtitleTimingSource must be listed in the checkpoint allowlist, and nothing else",
  );

  for (const timingSource of declared) {
    const parsed = parseAvatarProviderCheckpoint(
      serializeAvatarProviderCheckpoint(checkpointAt(timingSource) as never),
    );
    assert.ok(
      parsed,
      `a checkpoint carrying ${timingSource} must survive the provider wait — refusing it strands an avatar job that HeyGen has already been paid for`,
    );
    assert.equal(parsed.subtitleTimingSource, timingSource, "the timing source round-trips unchanged");
  }

  // ---- HERO-14 specifically --------------------------------------------
  assert.ok(
    parseAvatarProviderCheckpoint(
      serializeAvatarProviderCheckpoint(checkpointAt("partial_forced_alignment") as never),
    ),
    "partial_forced_alignment is the value that stranded 5 production jobs on 2026-09-09",
  );

  // ---- absent is still fine, and nothing else was loosened -------------
  assert.ok(parseAvatarProviderCheckpoint(serializeAvatarProviderCheckpoint(checkpointAt() as never)),
    "an older checkpoint with no timing source still parses");
  assert.equal(
    parseAvatarProviderCheckpoint(JSON.stringify({ ...checkpointAt(), subtitleTimingSource: "made_up_clock" })),
    null,
    "an unknown timing source is still refused",
  );
  for (const [field, value] of [
    ["provider", "runway"],
    ["version", 2],
    ["phase", "not_a_phase"],
    ["baseUrl", ""],
    ["audioDurationMs", -1],
    ["providerDeadlineAt", "2026-09-09T14:00:00.000Z"],
    ["baseConfig", "not-a-record"],
  ] as const) {
    assert.equal(
      parseAvatarProviderCheckpoint(JSON.stringify({ ...checkpointAt("forced_alignment"), [field]: value })),
      null,
      `a malformed ${field} must still fail closed`,
    );
  }
  assert.equal(
    parseAvatarProviderCheckpoint(JSON.stringify({
      ...checkpointAt("forced_alignment"),
      avatar: { ...checkpointAt("forced_alignment").avatar, introVideoId: undefined },
    })),
    null,
    "intro_wait without an intro video id must still fail closed",
  );
  assert.equal(parseAvatarProviderCheckpoint("{not json"), null, "unparseable input still fails closed");
  assert.equal(parseAvatarProviderCheckpoint(null), null, "no checkpoint is not an error");

  // ---- the trap must stay disarmed -------------------------------------
  const parser = fs.readFileSync("src/lib/mcp/avatar-provider-checkpoint.ts", "utf8");
  assert.match(
    parser,
    /Record<SubtitleTimingSource, true>/,
    "the allowlist must stay a total Record so a new union member is a compile error",
  );
  assert.doesNotMatch(
    parser,
    /value === "provider_alignment"/,
    "do not go back to a hand-maintained `||` chain — that is what failed twice",
  );

  console.log("verify-avatar-checkpoint-timing-sources: ALL PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
