// avatar-steps orchestration against a mock PipelineCaller: correct endpoint calls per mode
// and burn target = compositeUrl.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-avatar-steps.ts
import { runAvatarComposite, pollAvatar } from "../src/lib/mcp/avatar-steps";
import type { PipelineCaller } from "../src/lib/mcp/pipeline-client";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }
const noSleep = (_ms: number) => Promise.resolve();

// Mock caller: records POSTs, returns canned responses by path.
function mock(pollSeq: Record<string, string[]>) {
  const calls: { path: string; body: any }[] = [];
  const pollIdx: Record<string, number> = {};
  const caller: PipelineCaller = {
    async post<T>(path: string, body: any): Promise<T> {
      calls.push({ path, body });
      if (path === "/api/videos/trim-audio") return { audioUrl: `trimmed:${body.durationSecs ?? "T" + body.tailSecs}` } as T;
      if (path === "/api/heygen/generate-with-bg") return { videoId: `hg-${body.audioUrl}` } as T;
      if (path === "/api/videos/poll-avatar") {
        const seq = pollSeq[body.videoId] ?? ["completed"];
        const i = Math.min(pollIdx[body.videoId] ?? 0, seq.length - 1);
        pollIdx[body.videoId] = (pollIdx[body.videoId] ?? 0) + 1;
        const status = seq[i];
        return { status, videoUrl: status === "completed" ? `avatar:${body.videoId}` : null, thumbnailUrl: null, errorMsg: status === "failed" ? "boom" : null } as T;
      }
      if (path === "/api/heygen/composite") return { videoUrl: "COMPOSITE", usedMode: "chromakey" } as T;
      throw new Error("unexpected path " + path);
    },
    patch: async () => ({} as any),
    get: async () => ({} as any),
  };
  return { caller, calls };
}

async function main() {
  // full: no trim, 1 gen, composite without tailAvatarVideoUrl
  {
    const { caller, calls } = mock({});
    const r = await runAvatarComposite(caller, { baseUrl: "BASE", ttsAudioUrl: "TTS", avatarMode: "full", avatarId: "av", introSecs: 5, tailSecs: 5, sleep: noSleep });
    assert(r.compositeUrl === "COMPOSITE", "full → compositeUrl returned");
    assert(!calls.some((c) => c.path === "/api/videos/trim-audio"), "full → no trim-audio");
    const gens = calls.filter((c) => c.path === "/api/heygen/generate-with-bg");
    assert(gens.length === 1 && gens[0].body.audioUrl === "TTS" && gens[0].body.greenScreen === true, "full → 1 gen from full TTS audio, greenScreen");
    const comp = calls.find((c) => c.path === "/api/heygen/composite")!;
    assert(comp.body.bgVideoUrl === "BASE" && comp.body.avatarTiming === "full" && !comp.body.tailAvatarVideoUrl, "full → composite bg=BASE, timing=full, no tail");
    const gen0 = calls.find((c) => c.path === "/api/heygen/generate-with-bg")!;
    assert(gen0.body.scale === 1.0, "generate uses HeyGen framing scale 1.0 (whole/uncut)");
    const comp0 = calls.find((c) => c.path === "/api/heygen/composite")!;
    assert(comp0.body.avatarLayout.scale === 1 && comp0.body.avatarLayout.offsetX === 0 && comp0.body.avatarLayout.offsetY === 0, "composite layer = 1/0/0 by default");
  }

  // bookend: trim intro, 1 gen from trimmed
  {
    const { caller, calls } = mock({});
    await runAvatarComposite(caller, { baseUrl: "BASE", ttsAudioUrl: "TTS", avatarMode: "bookend", avatarId: "av", introSecs: 4, tailSecs: 5, sleep: noSleep });
    const trims = calls.filter((c) => c.path === "/api/videos/trim-audio");
    assert(trims.length === 1 && trims[0].body.durationSecs === 4, "bookend → 1 trim intro (durationSecs)");
    const gen = calls.find((c) => c.path === "/api/heygen/generate-with-bg")!;
    assert(gen.body.audioUrl === "trimmed:4", "bookend → gen uses trimmed intro audio");
  }

  // bookend-both: trim intro + tail, 2 gens, composite with tailAvatarVideoUrl
  {
    const { caller, calls } = mock({});
    const r = await runAvatarComposite(caller, { baseUrl: "BASE", ttsAudioUrl: "TTS", avatarMode: "bookend-both", avatarId: "av", introSecs: 3, tailSecs: 6, sleep: noSleep });
    const trims = calls.filter((c) => c.path === "/api/videos/trim-audio");
    assert(trims.length === 2 && trims[0].body.durationSecs === 3 && trims[1].body.tailSecs === 6, "bookend-both → trim intro(durationSecs) + tail(tailSecs)");
    assert(calls.filter((c) => c.path === "/api/heygen/generate-with-bg").length === 2, "bookend-both → 2 gens");
    const comp = calls.find((c) => c.path === "/api/heygen/composite")!;
    assert(!!comp.body.tailAvatarVideoUrl && comp.body.avatarTiming === "bookend-both", "bookend-both → composite carries tailAvatarVideoUrl");
    assert(r.tailAvatarUrl !== undefined, "bookend-both → returns tailAvatarUrl");
  }

  // tunable layout: composite uses passed layout, generate still uses the fixed gen framing (1.0)
  {
    const { caller, calls } = mock({});
    await runAvatarComposite(caller, { baseUrl:"BASE", ttsAudioUrl:"TTS", avatarMode:"full", avatarId:"av", introSecs:5, tailSecs:5, layout:{scale:1.4,offsetX:0,offsetY:0.2}, sleep: noSleep });
    const comp = calls.find((c) => c.path === "/api/heygen/composite")!;
    assert(comp.body.avatarLayout.scale === 1.4 && comp.body.avatarLayout.offsetY === 0.2, "composite uses passed layout");
    const gen = calls.find((c) => c.path === "/api/heygen/generate-with-bg")!;
    assert(gen.body.scale === 1.0, "generate still uses 1.0 regardless of composite layout");
  }

  // pollAvatar: completed → url; failed → throw
  {
    const { caller } = mock({ "hg-x": ["processing", "processing", "completed"] });
    const url = await pollAvatar(caller, "hg-x", { intervalMs: 1, sleep: noSleep });
    assert(url === "avatar:hg-x", "pollAvatar returns url on completed");
    const { caller: c2 } = mock({ "hg-y": ["failed"] });
    let threw = false;
    try { await pollAvatar(c2, "hg-y", { intervalMs: 1, sleep: noSleep }); } catch { threw = true; }
    assert(threw, "pollAvatar throws on failed");
  }

  console.log(`\n${passed} assertions passed ✅`);
}

main().catch((e) => { console.error(e); process.exit(1); });
