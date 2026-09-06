// Desktop transcribe route + metering. Run against a throwaway SQLite DB:
//   node --import ./scripts/register-server-only-node.mjs --import tsx scripts/verify-desktop-transcribe.ts
//   npm run verify:desktop-transcribe
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "desktop-transcribe-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.DESKTOP_TRANSCRIBE_VERIFY = "1";
process.env.DESKTOP_APP = "1";
process.env.DESKTOP_ALLOWLIST = "";
execSync("./node_modules/.bin/prisma db push --skip-generate", { stdio: "ignore", env: process.env });

const THAI_TEXT = /[ก-๙]/;
const ROUTE_PATH = join(process.cwd(), "src/app/api/desktop/transcribe/route.ts");

let passed = 0;
function assert(c: boolean, m: string) {
  if (!c) {
    console.error("❌ " + m);
    process.exit(1);
  }
  console.log("✓ " + m);
  passed++;
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

function tinyAudio(name: string, type: string, bytes = 64): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function transcribeReq(
  token: string,
  fields: { audio?: File; durationSec?: string; footageId?: string },
): Request {
  const form = new FormData();
  if (fields.audio) form.append("audio", fields.audio);
  if (fields.durationSec !== undefined) form.append("durationSec", fields.durationSec);
  if (fields.footageId !== undefined) form.append("footageId", fields.footageId);
  return new Request("http://localhost/api/desktop/transcribe", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

const okResult = {
  words: [{ w: "สวัสดี", start: 0, end: 0.4 }],
  segments: [{ text: "สวัสดี", start: 0, end: 0.4 }],
  language: "th-TH",
  provider: "mock",
};

async function main() {
  const routeSource = readFileSync(ROUTE_PATH, "utf8");
  assert(routeSource.includes("withDesktop"), "route uses withDesktop");
  assert(/export const POST = withDesktop\(/.test(routeSource), "POST is wrapped by withDesktop");

  const { prisma } = await import("../src/lib/prisma");
  const { createMcpToken } = await import("../src/lib/mcp/token");
  const {
    resolveDesktopSttProvider,
    setDesktopSttProviderForTests,
  } = await import("../src/lib/desktop/stt");
  const { __resetDesktopTranscribeRateForTest } = await import("../src/lib/desktop/stt/rate-limit");
  const { POST } = await import("../src/app/api/desktop/transcribe/route");

  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: {
      name: "desktop-stt",
      email: "desktop-stt@t.test",
      clerkId: "clerk_desktop_stt",
      plan: "PRO",
      subStatus: "active",
      minutesLimit: 80,
      minutesUsed: 0,
      aiAudioMinutesUsed: 0,
      aiTextCallsUsed: 0,
      usagePeriodStartedAt: new Date(),
    },
  });
  const { token: pat } = await createMcpToken(user.id, "desktop-stt");

  const usedOf = async () =>
    (await prisma.user.findUnique({
      where: { id: user.id },
      select: { aiAudioMinutesUsed: true },
    }))!.aiAudioMinutesUsed;

  const stubUser = { geminiKey: null, plan: "PRO" };

  // Provider switch by env (no live Gemini)
  delete process.env.DESKTOP_STT_PROVIDER;
  assert(resolveDesktopSttProvider(stubUser).name === "gemini-transcribe", "default provider is gemini-transcribe");
  process.env.DESKTOP_STT_PROVIDER = "gemini-transcribe";
  assert(resolveDesktopSttProvider(stubUser).name === "gemini-transcribe", "DESKTOP_STT_PROVIDER=gemini-transcribe");
  process.env.DESKTOP_STT_PROVIDER = "hero-chunked";
  assert(resolveDesktopSttProvider(stubUser).name === "hero-chunked", "DESKTOP_STT_PROVIDER=hero-chunked");
  process.env.DESKTOP_STT_PROVIDER = "gemini-transcribe";

  setDesktopSttProviderForTests({
    name: "mock",
    async transcribe() {
      return okResult;
    },
  });
  __resetDesktopTranscribeRateForTest();

  const happy = await POST(transcribeReq(pat, {
    audio: tinyAudio("clip.m4a", "audio/mp4"),
    durationSec: "90",
    footageId: "ft_1",
  }));
  const happyBody = await jsonOf(happy);
  assert(happy.status === 200, "mocked provider → 200");
  assert(Array.isArray(happyBody.words) && (happyBody.words as unknown[]).length === 1, "response has words");
  assert(Array.isArray(happyBody.segments), "response has segments");
  assert(happyBody.language === "th-TH", "response language is th-TH");
  assert(typeof happyBody.provider === "string", "response has provider");
  assert(await usedOf() === 2, "90s reserves ceil(90/60)=2 minutes");

  // over-ceiling → 402 AI_AUDIO_QUOTA {remaining} with Thai message
  await prisma.user.update({ where: { id: user.id }, data: { aiAudioMinutesUsed: 160 } });
  __resetDesktopTranscribeRateForTest();
  const over = await POST(transcribeReq(pat, {
    audio: tinyAudio("clip.wav", "audio/wav"),
    durationSec: "60",
    footageId: "ft_2",
  }));
  const overBody = await jsonOf(over);
  assert(over.status === 402, "over-ceiling → 402");
  assert(overBody.code === "AI_AUDIO_QUOTA", "over-ceiling → AI_AUDIO_QUOTA");
  assert(typeof overBody.remaining === "number", "402 body has remaining");
  assert(overBody.remaining === 0, "at ceiling remaining is 0");
  assert(typeof overBody.message === "string" && THAI_TEXT.test(overBody.message as string), "402 Thai message");
  assert(await usedOf() === 160, "blocked reserve did not increment");

  // refund on provider failure
  await prisma.user.update({ where: { id: user.id }, data: { aiAudioMinutesUsed: 10 } });
  setDesktopSttProviderForTests({
    name: "mock-fail",
    async transcribe() {
      throw new Error("provider down");
    },
  });
  __resetDesktopTranscribeRateForTest();
  const failed = await POST(transcribeReq(pat, {
    audio: tinyAudio("clip.m4a", "audio/mp4"),
    durationSec: "60",
    footageId: "ft_3",
  }));
  const failedBody = await jsonOf(failed);
  assert(failed.status === 502, "provider failure → 502");
  assert(failedBody.code === "STT_FAILED", "provider failure → STT_FAILED");
  assert(typeof failedBody.message === "string" && THAI_TEXT.test(failedBody.message as string), "502 Thai message");
  assert(await usedOf() === 10, "refund on provider failure restores reserved minutes");

  // 30 MB file → 413 (before reserve)
  setDesktopSttProviderForTests({
    name: "mock",
    async transcribe() {
      return okResult;
    },
  });
  __resetDesktopTranscribeRateForTest();
  const big = await POST(transcribeReq(pat, {
    audio: tinyAudio("huge.m4a", "audio/mp4", 30 * 1024 * 1024),
    durationSec: "60",
    footageId: "ft_4",
  }));
  const bigBody = await jsonOf(big);
  assert(big.status === 413, "30 MB file → 413");
  assert(typeof bigBody.code === "string", "413 has stable code");
  assert(typeof bigBody.message === "string" && THAI_TEXT.test(bigBody.message as string), "413 Thai message");
  assert(await usedOf() === 10, "413 does not reserve minutes");

  setDesktopSttProviderForTests(null);
  __resetDesktopTranscribeRateForTest();
  await prisma.mcpToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  console.log(`\n✅ ALL ${passed} DESKTOP TRANSCRIBE CHECKS PASSED`);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
