// avatar-steps orchestration against a mock PipelineCaller: correct endpoint calls per mode
// and burn target = compositeUrl.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-avatar-steps.ts
import { attemptAvatarComposite, generateAvatarVideo, runAvatarComposite, pollAvatar, pollAvatarOnce, uploadAvatarAudio, HEYGEN_FRAMING } from "../src/lib/mcp/avatar-steps";
import { PipelineHttpError, type PipelineCaller } from "../src/lib/mcp/pipeline-client";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }
const noSleep = (_ms: number) => Promise.resolve();

// Mock caller: records POSTs, returns canned responses by path.
function mock(pollSeq: Record<string, string[]>) {
  const calls: { path: string; body: any; opts?: { retries?: number } }[] = [];
  const pollIdx: Record<string, number> = {};
  const caller: PipelineCaller = {
    async post<T>(path: string, body: any, opts?: { retries?: number }): Promise<T> {
      calls.push({ path, body, opts });
      if (path === "/api/videos/trim-audio") return { audioUrl: `trimmed:${body.durationSecs ?? "T" + body.tailSecs}` } as T;
      if (path === "/api/heygen/generate-with-bg") {
        if (body.avatarEngine !== "avatar_iii" && body.audioUrl) return { audioAssetId: "persisted-v3-asset" } as T;
        return { videoId: `hg-${body.audioAssetId ?? body.audioUrl}` } as T;
      }
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
  // The production HTTP adapter pins engine/idempotency on create and API version on poll.
  {
    const { caller, calls } = mock({ "hg-v3": ["processing"] });
    const uploaded = await uploadAvatarAudio(caller, "private-look", "/renders/intro.mp3", {
      engine: "avatar_v",
      apiVersion: "v3",
    });
    assert(uploaded.kind === "accepted" && uploaded.audioAssetId === "persisted-v3-asset", "v3 upload adapter returns the durable asset identity");
    const upload = calls[0]!;
    assert(upload.body.audioUrl === "/renders/intro.mp3" && upload.body.idempotencyKey === undefined, "free upload adapter sends no paid-create key");
    assert(upload.opts?.retries === 0, "v3 upload adapter uses one bounded attempt");
    const generated = await generateAvatarVideo(caller, "private-look", "persisted-v3-asset", {
      engine: "avatar_v",
      apiVersion: "v3",
      idempotencyKey: "stable-v3-intro-key",
    });
    assert(generated.kind === "accepted", "v3 generate adapter accepts the provider video id");
    const create = calls[1]!;
    assert(create.body.avatarEngine === "avatar_v" && create.body.audioAssetId === "persisted-v3-asset" && create.body.audioUrl === undefined && create.body.idempotencyKey === "stable-v3-intro-key", "v3 create adapter uses the persisted asset with pinned engine and stable key");
    assert(create.opts?.retries === 0, "paid v3 generate adapter disables automatic HTTP retry");
    await pollAvatarOnce(caller, "hg-v3", "v3");
    const poll = calls.find((call) => call.path === "/api/videos/poll-avatar")!;
    assert(poll.body.apiVersion === "v3", "poll adapter forwards the persisted v3 route");
  }

  {
    const failureCaller = (body: Record<string, unknown>, status = 503): PipelineCaller => ({
      post: async () => { throw new PipelineHttpError("POST", "/api/heygen/generate-with-bg", status, body); },
      patch: async () => ({} as never),
      get: async () => ({} as never),
    });
    const uploadFailed = await uploadAvatarAudio(
      failureCaller({ code: "transient", providerStatus: 503, providerOperation: "upload", userAction: "ลองใหม่" }),
      "private-look",
      "/renders/intro.mp3",
      { engine: "avatar_iv", apiVersion: "v3" },
    );
    assert(uploadFailed.kind === "rejected" && uploadFailed.code === "transient", "known upload failure is definitive because paid create was not submitted");
    const createUnknown = await generateAvatarVideo(
      failureCaller({ code: "transient", providerStatus: 503, userAction: "ลองใหม่" }),
      "private-look",
      "persisted-asset",
      { engine: "avatar_iv", apiVersion: "v3", idempotencyKey: "stable-create-key" },
    );
    assert(createUnknown.kind === "unknown", "ambiguous create transport failure is never classified for automatic resubmission");
    const compatibilityUnknown = await generateAvatarVideo(
      failureCaller({
        error: "avatar_engine_unknown",
        message: "ยังตรวจสอบรุ่นที่ Avatar นี้รองรับไม่ได้ กรุณาลองใหม่",
      }, 422),
      "private-look",
      "persisted-asset",
      { engine: "avatar_iv", apiVersion: "v3", idempotencyKey: "stable-compatibility-key" },
    );
    assert(
      compatibilityUnknown.kind === "rejected"
        && compatibilityUnknown.message === "ยังตรวจสอบรุ่นที่ Avatar นี้รองรับไม่ได้ กรุณาลองใหม่",
      "pre-create compatibility refusal preserves the owned customer message",
    );
  }

  // A durable VideoJob id follows the internal composite request so the route can expose
  // admission-queue vs active-ffmpeg state without trusting an arbitrary user's job.
  {
    const { caller, calls } = mock({});
    const result = await attemptAvatarComposite(caller, {
      baseUrl: "BASE",
      avatarMode: "bookend",
      introSecs: 5,
      tailSecs: 5,
      introVideoUrl: "AVATAR",
      videoJobId: "job-123",
    });
    const comp = calls.find((call) => call.path === "/api/heygen/composite")!;
    assert(result.kind === "completed", "composite request completes in the mock");
    assert(comp.body.videoJobId === "job-123", "composite request carries its owning VideoJob id");
  }

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
    assert(comp.opts?.retries === 0, "full → composite disables automatic HTTP retry");
    const gen0 = calls.find((c) => c.path === "/api/heygen/generate-with-bg")!;
    assert(gen0.body.scale === HEYGEN_FRAMING.scale, "generate uses the shared HeyGen gen-framing constant");
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

  // tunable layout: composite uses passed layout, generate still uses the shared gen framing constant
  {
    const { caller, calls } = mock({});
    await runAvatarComposite(caller, { baseUrl:"BASE", ttsAudioUrl:"TTS", avatarMode:"full", avatarId:"av", introSecs:5, tailSecs:5, layout:{scale:1.4,offsetX:0,offsetY:0.2}, sleep: noSleep });
    const comp = calls.find((c) => c.path === "/api/heygen/composite")!;
    assert(comp.body.avatarLayout.scale === 1.4 && comp.body.avatarLayout.offsetY === 0.2, "composite uses passed layout");
    const gen = calls.find((c) => c.path === "/api/heygen/generate-with-bg")!;
    assert(gen.body.scale === HEYGEN_FRAMING.scale, "generate uses the shared gen framing regardless of composite layout");
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

  // The HTTP adapter preserves a deterministic executor timeout as a terminal composite
  // outcome so the provider-resume policy cannot mistake it for a transient provider wait.
  {
    const caller: PipelineCaller = {
      post: async () => {
        throw new PipelineHttpError("POST", "/api/heygen/composite", 504, {
          code: "COMPOSITE_TIMEOUT",
          error: "ประกอบวิดีโอใช้เวลานานเกินกำหนด",
          retryable: false,
        });
      },
      patch: async () => ({} as never),
      get: async () => ({} as never),
    };
    const result = await attemptAvatarComposite(caller, {
      baseUrl: "BASE",
      avatarMode: "full",
      introSecs: 5,
      tailSecs: 5,
      introVideoUrl: "AVATAR",
    });
    assert(
      result.kind === "failed"
        && result.code === "COMPOSITE_TIMEOUT"
        && result.retryable === false,
      "composite adapter preserves terminal timeout classification",
    );
  }

  // A typed executor-capacity failure remains retryable; retry count is owned by the
  // provider-resume policy, not by this HTTP adapter.
  {
    const caller: PipelineCaller = {
      post: async () => {
        throw new PipelineHttpError("POST", "/api/heygen/composite", 503, {
          code: "COMPOSITE_TRANSIENT",
          error: "composite capacity temporarily unavailable",
          retryable: true,
        });
      },
      patch: async () => ({} as never),
      get: async () => ({} as never),
    };
    const result = await attemptAvatarComposite(caller, {
      baseUrl: "BASE",
      avatarMode: "full",
      introSecs: 5,
      tailSecs: 5,
      introVideoUrl: "AVATAR",
    });
    assert(
      result.kind === "failed"
        && result.code === "COMPOSITE_TRANSIENT"
        && result.retryable === true,
      "composite adapter preserves retryable capacity classification",
    );
  }

  console.log(`\n${passed} assertions passed ✅`);
}

main().catch((e) => { console.error(e); process.exit(1); });
