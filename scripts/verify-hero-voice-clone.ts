import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  HERO_VOICE_CLONE_CANARY_ROUTE_INVENTORY,
  heroVoiceCloneCanaryAccessDecision,
  isHeroVoiceCloneCanaryUser,
  isHeroVoiceCloneGenerationJob,
} from "../src/lib/omnivoice-policy";
import {
  heroVoiceClonePrivateJson,
  heroVoiceClonePrivateResponse,
} from "../src/lib/hero-voice-clone-response.server";

const read = (filename: string) => fs.readFileSync(filename, "utf8");

function routePath(filename: string): string {
  return `/${path.relative("src/app", path.dirname(filename)).split(path.sep).join("/")}`;
}

function walkRouteFiles(directory: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkRouteFiles(target, files);
    else if (entry.name === "route.ts") files.push(target);
  }
  return files;
}

const originalEnv = {
  OMNIVOICE_ENABLED: process.env.OMNIVOICE_ENABLED,
  HERO_VOICE_CLONING_ENABLED: process.env.HERO_VOICE_CLONING_ENABLED,
  OMNIVOICE_ALLOWED_USER_IDS: process.env.OMNIVOICE_ALLOWED_USER_IDS,
};

try {
  process.env.OMNIVOICE_ENABLED = "1";
  process.env.HERO_VOICE_CLONING_ENABLED = "1";
  process.env.OMNIVOICE_ALLOWED_USER_IDS = "canary-owner";

  const allowed = {
    id: "canary-owner",
    email: "mew@aoacademy.co",
    role: "USER",
    suspended: false,
  };
  assert.equal(isHeroVoiceCloneCanaryUser(allowed), true, "all three independent policy terms allow the canary owner");
  assert.deepEqual(heroVoiceCloneCanaryAccessDecision(null), { allowed: false, status: 401 });
  assert.deepEqual(
    heroVoiceCloneCanaryAccessDecision({ id: "canary-owner", email: "customer@example.com", role: "ADMIN" }),
    { allowed: false, status: 404 },
  );
  assert.deepEqual(heroVoiceCloneCanaryAccessDecision(allowed), { allowed: true, status: 200 });
  assert.equal(isHeroVoiceCloneCanaryUser(null), false, "missing/deleted actors fail closed");
  assert.equal(isHeroVoiceCloneCanaryUser({ ...allowed, suspended: true }), false, "suspended actors fail closed");
  assert.equal(
    isHeroVoiceCloneCanaryUser({ id: "canary-owner", email: "customer@example.com", role: "ADMIN" }),
    false,
    "ADMIN plus the ID allowlist cannot bypass the internal-tester term",
  );
  assert.equal(
    isHeroVoiceCloneCanaryUser({ id: "not-allowlisted", email: "mew@aoacademy.co", role: "ADMIN" }),
    false,
    "internal/admin status cannot bypass the user-ID allowlist",
  );
  assert.equal(
    isHeroVoiceCloneCanaryUser({ id: "canary-owner", email: "customer@example.com", role: "USER" }),
    false,
    "the user-ID allowlist cannot bypass the internal-tester term",
  );
  process.env.HERO_VOICE_CLONING_ENABLED = "0";
  assert.equal(isHeroVoiceCloneCanaryUser(allowed), false, "the clone switch fails closed");
  process.env.HERO_VOICE_CLONING_ENABLED = "1";
  process.env.OMNIVOICE_ENABLED = "0";
  assert.equal(isHeroVoiceCloneCanaryUser(allowed), false, "the parent OmniVoice server switch still fails closed");
  process.env.OMNIVOICE_ENABLED = "1";

  const cloneJob = {
    kind: "voice",
    model: "user_abc",
    providerModel: "omnivoice-clone",
    productSurface: "ai_studio",
    inputJson: JSON.stringify({
      version: 1,
      mode: "clone",
      cloneCanarySurface: "ai-studio",
      voiceId: "user_abc",
    }),
  };
  assert.equal(isHeroVoiceCloneGenerationJob(cloneJob), true);
  for (const [label, mismatch] of [
    ["kind", { kind: "image" }],
    ["provider model", { providerModel: "omnivoice" }],
    ["user voice model", { model: "voice_01" }],
    ["product surface", { productSurface: "hero_video" }],
    ["missing state", { inputJson: null }],
    ["invalid state", { inputJson: "{" }],
    ["state mode", { inputJson: JSON.stringify({ version: 1, mode: "tts", voiceId: "user_abc" }) }],
    ["state surface", {
      inputJson: JSON.stringify({ version: 1, mode: "clone", voiceId: "user_abc" }),
    }],
    ["state voice", {
      inputJson: JSON.stringify({
        version: 1,
        mode: "clone",
        cloneCanarySurface: "ai-studio",
        voiceId: "user_other",
      }),
    }],
  ] as const) {
    assert.equal(
      isHeroVoiceCloneGenerationJob({ ...cloneJob, ...mismatch }),
      false,
      `clone classifier fails closed on a mismatched ${label}`,
    );
  }
  assert.equal(
    isHeroVoiceCloneGenerationJob({
      ...cloneJob,
      model: "voice_01",
      providerModel: "omnivoice",
      productSurface: null,
      inputJson: JSON.stringify({ version: 1, mode: "tts", voiceId: "voice_01" }),
    }),
    false,
    "stock voice jobs stay outside the clone gate",
  );
  assert.equal(
    isHeroVoiceCloneGenerationJob({ kind: "image", model: "user_abc", providerModel: "omnivoice-clone" }),
    false,
    "non-voice jobs cannot be misclassified as clone jobs",
  );
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const privateJsonProbe = heroVoiceClonePrivateJson({ ok: true }, {
  headers: { "Cache-Control": "public, max-age=3600" },
});
assert.equal(privateJsonProbe.headers.get("Cache-Control"), "private, no-store");
const privateErrorProbe = heroVoiceClonePrivateResponse(new Response(null, {
  status: 500,
  headers: { "Cache-Control": "public" },
}));
assert.equal(privateErrorProbe.headers.get("Cache-Control"), "private, no-store");

const schema = read("prisma/schema.prisma");
const storage = read("src/lib/user-voices.server.ts");
const collectionRoute = read("src/app/api/omnivoice/user-voices/route.ts");
const itemRoute = read("src/app/api/omnivoice/user-voices/[id]/route.ts");
const stockCatalogRoute = read("src/app/api/omnivoice/voices/route.ts");
const catalogRoute = read("src/app/api/ai-studio/catalog/route.ts");
const studioVoiceRoute = read("src/app/api/ai-studio/voices/route.ts");
const studioJobsRoute = read("src/app/api/ai-studio/jobs/route.ts");
const studioJobRoute = read("src/app/api/ai-studio/jobs/[id]/route.ts");
const studioVoiceAudioRoute = read("src/app/api/ai-studio/voice-audio/[jobId]/route.ts");
const studioPage = read("src/app/(dashboard)/ai-studio/page.tsx");
const clonePanel = read("src/app/(dashboard)/ai-studio/HeroVoiceClonePanel.tsx");
const durable = read("src/lib/hero-voice-generation.server.ts");
const cloneAudioStorage = read("src/lib/hero-voice-clone-audio.server.ts");
const rollout = read("docs/ops/hero-voice-clone-rollout.md");

assert.match(schema, /model UserVoice\s*\{/);
assert.match(schema, /userVoices\s+UserVoice\[\]/);
assert.match(storage, /uploads["'], ["']user-voices/,
  "reference audio stays outside public/");
assert.match(storage, /MAX_REF_MS\s*=\s*15_000/,
  "the app must not accept references longer than the worker contract");
assert.match(storage, /mode:\s*0o700/,
  "the private reference directory is owner-only");
assert.match(storage, /mode:\s*0o600/,
  "reference WAV files are owner-only");
assert.doesNotMatch(storage, /public["'], ["']user-voices/);

for (const route of [collectionRoute, itemRoute, catalogRoute, studioVoiceRoute, studioJobsRoute]) {
  assert.match(route, /heroVoiceCloneCanaryAccessDecision\(user\)/,
    "clone surfaces call the shared 401/404/200 decision directly");
  assert.match(route, /access\.status === 401 \? ["']Unauthorized["'] : ["']Not found["']/,
    "clone surfaces use the exact unauthenticated/denied response body split");
  assert.match(route, /status:\s*access\.status/,
    "clone surfaces use the pure decision's exact response status");
  assert.match(route, /private, no-store|heroVoiceClonePrivateJson/,
    "clone responses must not enter a shared cache");
  assert.doesNotMatch(route, /user\.role\s*[!=]==?\s*["']ADMIN["']/,
    "clone routes have no role-based bypass");
}
assert.match(studioVoiceAudioRoute, /heroVoiceCloneCanaryAccessDecision\(user\)/);
assert.match(studioVoiceAudioRoute, /access\.status === 401 \? ["']Unauthorized["'] : ["']Not found["']/);
assert.match(studioVoiceAudioRoute, /privateJson\([\s\S]{0,140}access\.status/);
assert.match(studioVoiceAudioRoute, /private, no-store/);

assert.match(collectionRoute, /listUserVoices\(gate\.user\.id\)/,
  "clone lists are owner scoped");
assert.match(collectionRoute, /userId:\s*gate\.user\.id/,
  "clone creation is owner scoped");
assert.match(collectionRoute, /consent/,
  "upload requires an explicit voice-rights acknowledgement");
assert.match(itemRoute, /readUserVoiceWav\(gate\.user\.id, id\)/,
  "private reference playback is owner scoped");
assert.match(itemRoute, /deleteUserVoice\(gate\.user\.id, id\)/,
  "deletion is owner scoped");

assert.match(studioVoiceRoute, /if \(!isUserVoiceId\(voiceId\)\)[\s\S]{0,100}status:\s*404/,
  "AI Studio clone submission refuses every stock or malformed ID as 404");
assert.match(studioVoiceRoute, /userId:\s*user\.id/,
  "durable generation receives only the authenticated owner ID");
assert.match(studioVoiceRoute, /cloneCanarySurface:\s*["']ai-studio["']/,
  "only the AI Studio clone route opts into durable clone generation");
assert.match(studioVoiceRoute, /const storedIdempotencyKey = `studio-voice:\$\{idempotencyKey\}`;/,
  "caller idempotency keys remain server-namespaced");

assert.match(catalogRoute, /cloning:\s*true/,
  "an allowed catalog advertises the clone canary");
assert.doesNotMatch(catalogRoute, /available:\s*isOmniVoiceUserAllowed|user\.role/,
  "AI Studio's catalog does not advertise stock Hero Voice or an admin bypass");
assert.match(studioPage, /["']cloning["'], ["']โคลนเสียง["']/);
assert.doesNotMatch(studioPage, /["']voice["'], ["']สร้างเสียง["']|\/api\/omnivoice\/voices/,
  "AI Studio withholds its old stock Hero Voice tab/catalog");
assert.match(clonePanel, /navigator\.mediaDevices\.getUserMedia/);
assert.match(clonePanel, /REF_MAX_SEC\s*=\s*15/);
assert.match(clonePanel, /ยืนยันว่าฉันเป็นเจ้าของเสียง/);

assert.doesNotMatch(stockCatalogRoute, /user-voices|UserVoice|listUserVoices|userVoiceIdFor|isHeroVoiceCloningEnabled/,
  "the stock catalog never joins or exposes user clones");
assert.match(stockCatalogRoute, /RUNPOD_HERO_VOICES/,
  "the existing stock RunPod catalog remains available on its original route");

assert.match(studioJobRoute, /isHeroVoiceCloneGenerationJob\(job\)/,
  "the mixed AI Studio status route classifies clone jobs explicitly");
assert.match(studioJobRoute, /!cloneCanaryJob \|\| !isHeroVoiceCloneCanaryUser\(user\)/,
  "clone status uses the canary policy and withholds old stock Studio jobs");
assert.match(studioJobRoute, /return heroVoiceClonePrivateJson\(\{ job:/,
  "clone job status responses are private and non-cacheable");
assert.match(studioJobsRoute, /\{ kind: ["']voice["'], providerModel: ["']omnivoice-clone["'], model: \{ startsWith: ["']user_["'] \} \}/,
  "AI Studio history includes only owned clone jobs alongside images");
assert.match(studioJobsRoute, /job\.kind === ["']image["'] \|\| isHeroVoiceCloneGenerationJob\(job\)/,
  "AI Studio history fails closed on inconsistent clone job markers");
assert.match(studioVoiceAudioRoute, /id:\s*jobId, userId:\s*user\.id/,
  "generated clone audio is owner scoped before the filesystem is touched");
assert.match(studioVoiceAudioRoute, /isHeroVoiceCloneGenerationJob\(job\)/,
  "the private audio route serves only clone jobs");
assert.match(studioVoiceAudioRoute, /status:\s*416/,
  "the private audio route handles invalid ranges without exposing bytes");
assert.match(cloneAudioStorage, /path\.join\(referenceRoot, ["']generated["']\)/,
  "generated clone audio shares the owner-only non-public storage root");
assert.match(cloneAudioStorage, /mode:\s*0o700/,
  "generated clone audio directories are owner-only");

for (const [filename, route] of [
  ["src/app/api/ai-studio/jobs/route.ts", studioJobsRoute],
  ["src/app/api/ai-studio/jobs/[id]/route.ts", studioJobRoute],
] as const) {
  assert.doesNotMatch(route, /NextResponse\.json/,
    `${filename} cannot bypass the private clone response wrapper`);
  assert.match(route, /heroVoiceClonePrivateResponse\(apiError\(/,
    `${filename} wraps unexpected errors with the exact private cache policy`);
}
assert.match(
  studioJobRoute,
  /findFirst\(\{ where: \{ id, userId: user\.id \} \}\)[\s\S]{0,120}if \(!job\) return heroVoiceClonePrivateJson\([\s\S]{0,80}status: 404/,
  "owner and cross-owner job misses use the exact private response wrapper",
);

assert.match(durable, /async function requireHeroVoiceCloneCanaryActor[\s\S]{0,400}isHeroVoiceCloneCanaryUser\(actor\)/,
  "durable generation owns a shared-policy recheck");
assert.match(durable, /input\.cloneCanarySurface !== ["']ai-studio["']/,
  "direct Story Film, Video Editor, and MCP calls cannot opt into clone by voice ID alone");
assert.match(durable, /await requireHeroVoiceCloneCanaryActor\(input\.userId\)/,
  "durable start rechecks the actor before configuration or job creation");
assert.match(durable, /await loadUserVoiceRef\(input\.userId, input\.voiceId\)/,
  "durable start proves owner-scoped voice existence before job creation");
assert.ok(
  (durable.match(/await requireHeroVoiceCloneCanaryActor\(/g) ?? []).length >= 4,
  "start, submit, advance, and cancel all recheck the clone policy",
);
for (const functionName of ["advanceHeroVoiceGeneration", "cancelHeroVoiceGeneration"]) {
  const implementationName = `${functionName}Unlocked`;
  const functionStart = durable.indexOf(`async function ${implementationName}`);
  assert.ok(functionStart >= 0, `${implementationName} must remain present`);
  const functionEnd = durable.indexOf("\n}", functionStart);
  assert.ok(functionEnd >= 0, `${implementationName} must have a searchable function boundary`);
  const functionSource = durable.slice(functionStart, functionEnd + 2);
  const classifierIndex = functionSource.indexOf("const cloneCanaryJob = isHeroVoiceCloneDurableRecord(job)");
  const policyIndex = functionSource.indexOf("await requireHeroVoiceCloneCanaryActor(userId)");
  const terminalIndex = functionSource.indexOf("isHeroVoiceCloneTerminalStatus(job.status)");
  assert.ok(
    [classifierIndex, policyIndex, terminalIndex].every((index) => index >= 0),
    `${functionName} must retain every clone policy-ordering token`,
  );
  assert.ok(
    classifierIndex < policyIndex && policyIndex < terminalIndex,
    `${functionName} classifies clone identity and enforces policy before every terminal return`,
  );
  assert.match(
    durable,
    new RegExp(`export async function ${functionName}\\([\\s\\S]{0,300}runHeroVoiceCanarySerializedMutation\\([\\s\\S]{0,200}${implementationName}\\(`),
    `${functionName} must serialize against deletion before entering the durable implementation`,
  );
}
assert.equal(
  (durable.match(/function requireExistingHeroVoiceGenerationInvariant\(/g) ?? []).length,
  1,
  "the durable module defines one existing-job invariant validator",
);
assert.equal(
  (durable.match(/function reconcileExistingHeroVoiceGeneration\(/g) ?? []).length,
  1,
  "the durable module defines one corruption-aware existing-job reconciler",
);
const reconcileStart = durable.indexOf("async function reconcileExistingHeroVoiceGeneration");
const reconcileSource = durable.slice(reconcileStart, durable.indexOf("\n}", reconcileStart) + 2);
assert.match(reconcileSource, /isHeroVoiceCloneDurableRecord\(job\)[\s\S]*validateCloneDurableIdentity\(job, state, attempts\)/,
  "clone replays validate their complete durable identity before returning");
assert.match(reconcileSource, /return failCorruptCloneJob\(job\)/,
  "corrupt clone replays terminalize and reconcile their external run");
assert.match(reconcileSource, /return requireExistingHeroVoiceGenerationInvariant\(job, expected\)/,
  "every accepted replay still passes the shared request/job invariant validator");
assert.match(durable, /if \(existing\)[\s\S]{0,300}reconcileExistingHeroVoiceGeneration\(existing/,
  "the normal idempotency replay path uses the corruption-aware reconciler");
assert.match(durable, /code\?: string[\s\S]{0,300}P2002[\s\S]{0,420}reconcileExistingHeroVoiceGeneration\(raced/,
  "the P2002 recovery path uses the same corruption-aware reconciler");
assert.match(durable, /if \(!createdInTransaction\)[\s\S]{0,180}reconcileExistingHeroVoiceGeneration\(created/,
  "the in-transaction collision path uses the same corruption-aware reconciler");
assert.match(durable, /else if \(input\.cloneCanarySurface !== undefined \|\| input\.cloneSeed !== undefined\)[\s\S]{0,180}USER_VOICE_NOT_FOUND/,
  "stock Hero Voice rejects an AI Studio clone surface marker");
assert.ok(
  durable.indexOf("await requireHeroVoiceCloneCanaryActor(input.userId)")
    < durable.indexOf('const cloneConfig = mode === "clone" ? heroVoiceCloneConfig()'),
  "policy and ownership fail before provider configuration",
);
assert.doesNotMatch(durable, /audioBase64:\s*ref\./,
  "reference bytes must never be persisted in durable job JSON");
assert.match(durable, /voiceUrl:\s*cloneMode[\s\S]{0,140}\/api\/ai-studio\/voice-audio/,
  "clone results use the authenticated private audio route");
assert.match(durable, /fs\.writeFileSync\(filePath,[\s\S]{0,120}cloneMode \? 0o600/,
  "generated clone WAVs are written owner-only");

for (const filename of [
  "src/lib/mcp/orchestrator.ts",
  "scripts/story-film-system-worker.ts",
  "src/app/api/videos/tts-omnivoice/route.ts",
]) {
  assert.doesNotMatch(read(filename), /cloneCanarySurface|isHeroVoiceCloneCanaryUser|user-voices/,
    `${filename} acquires no clone-canary routing`);
}

const candidateMarker = /heroVoiceCloneCanaryAccessDecision|isHeroVoiceCloneCanaryUser|authenticateHeroVoiceCanaryHttpRequest|isHeroVoiceCloneGenerationJob|(?:start|advance|cancel)HeroVoiceGeneration|cloneCanarySurface|heroVoiceClone(?:AudioDirectory|AudioFilePath|PartFilePath)|hero-voice-clone-audio|isUserVoiceId|user-voices|UserVoice|omnivoice-clone|voice-clone-canary/;
const discoveredCloneRoutes = walkRouteFiles("src/app/api")
  .filter((filename) => candidateMarker.test(read(filename)))
  .map(routePath)
  .sort();
const inventoriedRoutes = [...new Set(HERO_VOICE_CLONE_CANARY_ROUTE_INVENTORY.map((entry) => entry.route))].sort();
assert.deepEqual(
  discoveredCloneRoutes,
  inventoriedRoutes,
  "every clone-capable route must be explicitly classified in the policy inventory",
);
for (const entry of HERO_VOICE_CLONE_CANARY_ROUTE_INVENTORY) {
  const filename = path.join("src/app", entry.route.slice(1), "route.ts");
  const source = read(filename);
  assert.match(source, new RegExp(`export async function ${entry.method}\\b`),
    `${entry.method} ${entry.route} exists`);
  if (entry.scope === "durable-stock-caller") {
    assert.match(source, /cancelHeroVoiceGeneration/,
      `${entry.method} ${entry.route} is classified as a stock durable caller`);
    assert.doesNotMatch(source, /cloneCanarySurface|user-voices|omnivoice-clone/,
      `${entry.method} ${entry.route} does not opt into clone generation`);
  } else {
    assert.match(source, /heroVoiceCloneCanaryAccessDecision|isHeroVoiceCloneCanaryUser|authenticateHeroVoiceCanaryHttpRequest/,
      `${entry.method} ${entry.route} calls the shared policy directly or through the fail-closed Task 5 HTTP authenticator`);
  }
}

assert.match(rollout, /ADR 0060/);
assert.match(rollout, /Production rollout, merge, deployment,[\s\S]{0,80}out of scope/);
assert.match(rollout, /ADMIN[^\n]+not a clone entitlement/);
assert.doesNotMatch(rollout, /deploy\/deploy\.sh|Set `HERO_VOICE_CLONING_ENABLED=1` in the production/,
  "obsolete production/admin rollout instructions are gone");

console.log("Hero Voice clone canary policy, route matrix, inventory, ownership, and isolation checks passed.");
