import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { build } from "esbuild";

// Bundle the real entrypoints with inert dependencies: no Clerk, database,
// filesystem audio, provider, or billing operation can leave this harness.
async function loadSubject(
  filename: string,
  mocks: Record<string, Record<string, unknown>>,
  env: Record<string, string> = {},
) {
  const result = await build({
    entryPoints: [filename], bundle: true, write: false, platform: "node", format: "cjs",
    packages: "external", logLevel: "silent",
    plugins: [{ name: "private-route-fixtures", setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path: specifier }) => {
        if (specifier in mocks) return { path: specifier, namespace: "fixture" };
        if (specifier === "@/lib/hero-voice-clone-response.server") {
          return { path: path.resolve("src/lib/hero-voice-clone-response.server.ts") };
        }
        if (specifier.startsWith("@/lib/")) throw new Error(`Unmocked dependency: ${specifier}`);
        return undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: specifier }) => ({
        contents: Object.keys(mocks[specifier]).map((name) => name === "default"
          ? `export default globalThis.fixtures[${JSON.stringify(specifier)}].default;`
          : `export const ${name} = globalThis.fixtures[${JSON.stringify(specifier)}][${JSON.stringify(name)}];`).join("\n"),
      }));
    } }],
  });
  const cjsModule = { exports: {} };
  const logs: unknown[][] = [];
  vm.runInNewContext(result.outputFiles[0].text, {
    module: cjsModule, exports: cjsModule.exports, require: createRequire(path.resolve(filename)),
    fixtures: mocks, process: { env }, Response, Request, Headers, Buffer, Uint8Array,
    console: { error: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
  });
  return { exports: cjsModule.exports as Record<string, (...args: never[]) => Promise<unknown>>, logs };
}

async function main() {
  let legacyCalls = 0;
  let isolatedCalls = 0;
  let isolatedAllowed = false;
  const actor = { id: "private-test-owner", clerkId: "user_private_test", role: "USER", plan: "FREE" };
  const legacy = async () => { legacyCalls++; return actor; };
  const auth = await loadSubject("src/lib/clerk-auth.ts", {
    "@clerk/nextjs/server": { auth: async () => ({ userId: actor.clerkId, sessionClaims: {} }), currentUser: legacy },
    "next/headers": { cookies: legacy },
    "@prisma/client": { Prisma: {} },
    "@/lib/prisma": { prisma: { user: { findUnique: legacy } } },
    "@/lib/trial": { grantTrial: legacy, TRIAL_DAYS_PUBLIC: 7 },
    "@/lib/entitlements": { syncUserEntitlement: legacy, classifyEntitlement: () => ({ action: "KEEP" }) },
    "@/lib/mcp/service-actor": { resolveServiceActor: legacy },
    "@/lib/affiliate-ref": { AFF_COOKIE: "fixture", sanitizeRefCode: legacy },
    "@/lib/hero-voice-deletion-coordinator.server": {
      ensureHeroVoiceCanaryReadReady: async () => ({ mode: "ready" }),
      runHeroVoiceCanarySerializedMutation: async (fn: () => unknown) => fn(),
    },
    "@/lib/hero-voice-canary-auth.server": { assertHeroVoiceCanaryIsolatedEnvironment: () => {}, resolveHeroVoiceCanarySessionUser: async () => {
      isolatedCalls++;
      if (!isolatedAllowed) throw new Error("isolated authentication rejected");
      return actor;
    } },
  }, { HERO_VOICE_CANARY_EXECUTION_MODE: "1" });
  assert.equal(await auth.exports.getCurrentUser(), null, "invalid isolated auth must not accept a service actor or ordinary Clerk user");
  assert.equal(legacyCalls, 0, "denied canary auth must not read/write ordinary users, trials, or entitlements");
  isolatedAllowed = true;
  assert.equal(await auth.exports.getCurrentUser(), actor);
  assert.equal(isolatedCalls, 2);
  assert.equal(legacyCalls, 0, "accepted canary auth must use only the prebootstrapped actor");
  assert.equal(auth.logs.length, 0);

  const privateFilename = "/synthetic-private-audio/owner.wav";
  let failAt = "read";
  const fail = () => { throw new Error(`ENOENT: ${privateFilename}`); };
  const audio = await loadSubject("src/app/api/ai-studio/voice-audio/[jobId]/route.ts", {
    "node:fs": { default: {
      statSync: () => ({ isFile: () => true, size: 100 }),
      readFileSync: () => fail(),
    } },
    "@/lib/clerk-auth": { getCurrentUser: async () => { if (failAt === "auth") fail(); return actor; } },
    "@/lib/hero-voice-clone-audio.server": { heroVoiceCloneAudioFilePath: () => { if (failAt === "path") fail(); return privateFilename; } },
    "@/lib/omnivoice-policy": { heroVoiceCloneCanaryAccessDecision: () => ({ allowed: true }), isHeroVoiceCloneGenerationJob: () => true },
    "@/lib/prisma": { prisma: { aiGenerationJob: { findFirst: async () => ({ id: "job-fixture", status: "completed", outputUrl: "/api/ai-studio/voice-audio/job-fixture" }) } } },
  });
  for (failAt of ["read", "path", "auth"]) {
    const getAudio = audio.exports.GET as (request: Request, context: { params: Promise<{ jobId: string }> }) => Promise<Response>;
    const response = await getAudio(new Request("http://127.0.0.1/api/audio"), { params: Promise.resolve({ jobId: "job-fixture" }) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.doesNotMatch(await response.text(), /ENOENT|synthetic-private-audio|owner\.wav/);
  }
  assert.equal(audio.logs.length, 0, "private audio exceptions must not log the filesystem path");

  let grants = 0;
  const catalog = await loadSubject("src/app/api/ai-studio/catalog/route.ts", {
    "@/lib/clerk-auth": { getCurrentUser: async () => actor },
    "@/lib/ai-image-policy": { AI_IMAGE_MODELS: [] },
    "@/lib/credits": { ensureMonthlyGrant: async () => { grants++; }, getBalance: async () => 0 },
    "@/lib/plan-limits": { durationCapSecFor: () => 60 },
    "@/lib/omnivoice-limits": { omnivoiceScriptCharCapForPlan: () => 100 },
    "@/lib/omnivoice-policy": { heroVoiceCloneCanaryAccessDecision: () => ({ allowed: true }) },
    "@/lib/image-generation-provider.server": { describeImageOffer: () => ({}) },
    "@/lib/api-error": { apiError: async () => new Response(null, { status: 500 }) },
  }, { HERO_VOICE_CANARY_EXECUTION_MODE: "1" });
  assert.equal((await catalog.exports.GET() as Response).status, 200);
  assert.equal(grants, 0, "marked canary catalog must not grant ordinary monthly credits");

  const jobs = await loadSubject("src/app/api/ai-studio/jobs/route.ts", {
    "@/lib/clerk-auth": { getCurrentUser: async () => actor },
    "@/lib/prisma": { prisma: { aiGenerationJob: { findMany: async () => [] } } },
    "@/lib/credits": { ensureMonthlyGrant: async () => { grants++; }, getBalance: async () => 0 },
    "@/lib/ai-generation-jobs.server": { publicAiGenerationJob: (job: unknown) => job },
    "@/lib/omnivoice-policy": { heroVoiceCloneCanaryAccessDecision: () => ({ allowed: true }), isHeroVoiceCloneGenerationJob: () => true },
    "@/lib/hero-voice-clone-state": { normalizeHeroVoiceClonePublicJob: (job: unknown) => job },
    "@/lib/api-error": { apiError: () => new Response(null, { status: 500 }) },
  }, { HERO_VOICE_CANARY_EXECUTION_MODE: "1" });
  assert.equal((await jobs.exports.GET() as Response).status, 200);
  assert.equal(grants, 0, "marked canary job history must not grant ordinary monthly credits");

  const workflow = fs.readFileSync(".github/workflows/hero-voice-clone-canary-image.yml", "utf8");
  assert.match(workflow, /build:\s*\n\s*#.*\n\s*if: \$\{\{ false \}\}/, "image publication must stay disabled while rights are NO-GO");
  console.log("Private canary auth, credit isolation, filesystem-error responses, and publication freeze verified.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
