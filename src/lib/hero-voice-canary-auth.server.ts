import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  heroVoiceCanaryJcsBytes,
  heroVoiceCanarySha256,
  parseHeroVoiceCanaryStrictJson,
} from "@/lib/hero-voice-canary-canonical";
import {
  computeHeroVoiceCanaryOwnerHmac,
  runHeroVoiceCanarySerializedMutation,
} from "@/lib/hero-voice-deletion-coordinator.server";
import {
  HERO_VOICE_CANARY_DATABASE_MARKER_KEY,
  HERO_VOICE_CANARY_DATABASE_MARKER_VALUE,
  heroVoiceCanaryStorageContext,
} from "@/lib/hero-voice-canary-storage.server";
import { prisma } from "@/lib/prisma";
import { heroVoiceCloneCanaryAccessDecision } from "@/lib/omnivoice-policy";

export const HERO_VOICE_CANARY_AUTH_AUDIENCE = "hero-voice-clone-canary-v1" as const;
export const HERO_VOICE_CANARY_BOOTSTRAP_MARKER_KEY = "hero_voice_canary_bootstrap_user_v1" as const;
export const HERO_VOICE_CANARY_CREDIT_POLICY_KEY = "hero_voice_canary_credit_policy_v1" as const;
const HEX64 = /^[0-9a-f]{64}$/u;
const SAFE_SUBJECT = /^user_[A-Za-z0-9_-]{4,120}$/u;

export class HeroVoiceCanaryAuthError extends Error {
  constructor(readonly code = "CANARY_AUTH_INVALID", readonly status = 404) {
    super("Not found");
    this.name = "HeroVoiceCanaryAuthError";
  }
}

export type HeroVoiceCanaryClaims = Readonly<{
  authIssuer: string;
  authSubject: string;
  authAudience: typeof HERO_VOICE_CANARY_AUTH_AUDIENCE;
}>;
export type HeroVoiceCanaryAuthState = Readonly<{ userId: string | null; sessionClaims: unknown }>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value) throw new HeroVoiceCanaryAuthError("CANARY_AUTH_CONFIG_INVALID", 503);
  return value;
}

function singleAudience(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return null;
}

/** The only Clerk JWT-shape boundary. Everything below this function consumes
 * the canonical domain shape, never raw `iss`/`sub`/`aud` objects. */
export function parseHeroVoiceCanaryClerkClaims(value: unknown, authenticatedUserId: string): HeroVoiceCanaryClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HeroVoiceCanaryAuthError();
  const record = value as Record<string, unknown>;
  const issuer = record.iss;
  const subject = record.sub;
  const audience = singleAudience(record.aud);
  const expectedIssuer = requiredEnvironment("HERO_VOICE_CANARY_AUTH_ISSUER");
  const expectedSubject = requiredEnvironment("HERO_VOICE_CANARY_AUTH_SUBJECT");
  const expectedAudience = requiredEnvironment("HERO_VOICE_CANARY_AUTH_AUDIENCE");
  if (typeof issuer !== "string" || issuer !== expectedIssuer
    || typeof subject !== "string" || subject !== authenticatedUserId
    || subject !== expectedSubject || !SAFE_SUBJECT.test(subject)
    || audience !== HERO_VOICE_CANARY_AUTH_AUDIENCE || expectedAudience !== HERO_VOICE_CANARY_AUTH_AUDIENCE) {
    throw new HeroVoiceCanaryAuthError();
  }
  return Object.freeze({ authIssuer: issuer, authSubject: subject, authAudience: HERO_VOICE_CANARY_AUTH_AUDIENCE });
}

function validateCanonicalClaims(value: HeroVoiceCanaryClaims): HeroVoiceCanaryClaims {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["authAudience", "authIssuer", "authSubject"])
    || value.authIssuer !== requiredEnvironment("HERO_VOICE_CANARY_AUTH_ISSUER")
    || value.authSubject !== requiredEnvironment("HERO_VOICE_CANARY_AUTH_SUBJECT")
    || !SAFE_SUBJECT.test(value.authSubject)
    || value.authAudience !== HERO_VOICE_CANARY_AUTH_AUDIENCE
    || requiredEnvironment("HERO_VOICE_CANARY_AUTH_AUDIENCE") !== HERO_VOICE_CANARY_AUTH_AUDIENCE) {
    throw new HeroVoiceCanaryAuthError();
  }
  return value;
}

function assertTestClerkConfiguration(): void {
  const issuer = requiredEnvironment("HERO_VOICE_CANARY_AUTH_ISSUER");
  let url: URL;
  try { url = new URL(issuer); } catch { throw new HeroVoiceCanaryAuthError("CANARY_AUTH_CONFIG_INVALID", 503); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash
    || !/^[a-z0-9-]+\.clerk\.accounts\.dev$/u.test(url.hostname)) {
    throw new HeroVoiceCanaryAuthError("CANARY_AUTH_CONFIG_INVALID", 503);
  }
  const publishableKey = requiredEnvironment("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  const secretKey = requiredEnvironment("CLERK_SECRET_KEY");
  if (!publishableKey.startsWith("pk_test_") || !secretKey.startsWith("sk_test_")
    || process.env.CLERK_WEBHOOK_SECRET || process.env.STRIPE_SECRET_KEY
    || process.env.STRIPE_WEBHOOK_SECRET
    || process.env.HERO_VOICE_CANARY_EXTERNAL_BILLING_DISABLED !== "1"
    || process.env.HERO_VOICE_CANARY_WEBHOOKS_DISABLED !== "1") {
    throw new HeroVoiceCanaryAuthError("CANARY_AUTH_CONFIG_INVALID", 503);
  }
}

function assertNotProductionFingerprint(name: string, rawValue: string): void {
  const forbidden = (process.env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const digest = heroVoiceCanarySha256(rawValue);
  if (forbidden.some((item) => HEX64.test(item) && timingSafeEqual(Buffer.from(item, "hex"), Buffer.from(digest, "hex")))) {
    throw new HeroVoiceCanaryAuthError("CANARY_PRODUCTION_FINGERPRINT_REJECTED", 503);
  }
}

function readAuthAttestation(): void {
  const context = heroVoiceCanaryStorageContext();
  const filename = requiredEnvironment("HERO_VOICE_CANARY_AUTH_ATTESTATION_PATH");
  const expectedSha256 = requiredEnvironment("HERO_VOICE_CANARY_AUTH_ATTESTATION_SHA256");
  if (!path.isAbsolute(filename) || !HEX64.test(expectedSha256)
    || filename === context.canaryRoot || !filename.startsWith(`${context.canaryRoot}${path.sep}`)) {
    throw new HeroVoiceCanaryAuthError("CANARY_AUTH_ATTESTATION_INVALID", 503);
  }
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new HeroVoiceCanaryAuthError("CANARY_AUTH_ATTESTATION_INVALID", 503);
  }
  const bytes = fs.readFileSync(filename);
  if (heroVoiceCanarySha256(bytes) !== expectedSha256) throw new HeroVoiceCanaryAuthError("CANARY_AUTH_ATTESTATION_INVALID", 503);
  const parsed = parseHeroVoiceCanaryStrictJson(bytes);
  const expected = {
    audience: HERO_VOICE_CANARY_AUTH_AUDIENCE,
    issuerSha256: heroVoiceCanarySha256(requiredEnvironment("HERO_VOICE_CANARY_AUTH_ISSUER")),
    sessionCount: 2,
    subjectSha256: heroVoiceCanarySha256(requiredEnvironment("HERO_VOICE_CANARY_AUTH_SUBJECT")),
    testKeys: true,
    version: 1,
  };
  if (!heroVoiceCanaryJcsBytes(parsed).equals(heroVoiceCanaryJcsBytes(expected))) {
    throw new HeroVoiceCanaryAuthError("CANARY_AUTH_ATTESTATION_INVALID", 503);
  }
}

export function assertHeroVoiceCanaryIsolatedEnvironment(options: { requireAuthAttestation: boolean }): void {
  if (process.env.NODE_ENV === "production" || process.env.HERO_VOICE_CANARY_EXECUTION_MODE !== "1"
    || process.env.HERO_VOICE_CANARY_LISTEN_HOST !== "127.0.0.1") {
    throw new HeroVoiceCanaryAuthError("CANARY_ENVIRONMENT_INVALID", 503);
  }
  const context = heroVoiceCanaryStorageContext();
  assertNotProductionFingerprint("HERO_VOICE_CANARY_PRODUCTION_DATABASE_FINGERPRINTS", process.env.DATABASE_URL ?? "");
  assertNotProductionFingerprint("HERO_VOICE_CANARY_PRODUCTION_STORAGE_FINGERPRINTS", context.canaryRoot);
  assertTestClerkConfiguration();
  if (options.requireAuthAttestation) readAuthAttestation();
}

export async function verifiedHeroVoiceCanaryClaims(claimsInput: HeroVoiceCanaryClaims): Promise<HeroVoiceCanaryClaims> {
  assertHeroVoiceCanaryIsolatedEnvironment({ requireAuthAttestation: true });
  const claims = validateCanonicalClaims(claimsInput);
  const marker = await prisma.siteConfig.findUnique({ where: { key: HERO_VOICE_CANARY_BOOTSTRAP_MARKER_KEY } });
  const user = await prisma.user.findUnique({ where: { clerkId: claims.authSubject } });
  const users = await prisma.user.count();
  const expectedMarker = user ? heroVoiceCanarySha256(heroVoiceCanaryJcsBytes({
    version: 1,
    userIdSha256: heroVoiceCanarySha256(user.id),
    ownerHmac: computeHeroVoiceCanaryOwnerHmac(claims),
    creditPolicy: "isolated-finite-canary-v1",
  })) : "";
  if (!user || users !== 1 || marker?.value !== expectedMarker || user.suspended
    || user.stripeCustomerId || user.stripeSubscriptionId || user.trialStartedAt || user.trialEndsAt) {
    throw new HeroVoiceCanaryAuthError();
  }
  return claims;
}

export async function getBootstrappedHeroVoiceCanaryUser(claimsInput: HeroVoiceCanaryClaims) {
  const claims = await verifiedHeroVoiceCanaryClaims(claimsInput);
  const user = await prisma.user.findUnique({ where: { clerkId: claims.authSubject } });
  if (!user) throw new HeroVoiceCanaryAuthError();
  return { user, claims, ownerHmac: computeHeroVoiceCanaryOwnerHmac(claims) };
}

export async function authenticateHeroVoiceCanaryAuthState(authState: HeroVoiceCanaryAuthState) {
  if (!authState.userId) throw new HeroVoiceCanaryAuthError("CANARY_AUTH_REQUIRED", 401);
  const claims = parseHeroVoiceCanaryClerkClaims(authState.sessionClaims, authState.userId);
  const actor = await getBootstrappedHeroVoiceCanaryUser(claims);
  const access = heroVoiceCloneCanaryAccessDecision(actor.user);
  if (!access.allowed) throw new HeroVoiceCanaryAuthError("CANARY_AUTH_INVALID", access.status);
  return actor;
}

/** Explicit local bootstrap only. It never invokes Clerk user APIs, lazy-create,
 * trial, subscription, Stripe, webhook, or production-copy paths. */
export async function bootstrapHeroVoiceCanaryUser(input: {
  sessionClaims: unknown;
  authenticatedUserId: string;
  displayName: string;
  email: string;
  minutesLimit: number;
}): Promise<{ userId: string; ownerHmac: string }> {
  assertHeroVoiceCanaryIsolatedEnvironment({ requireAuthAttestation: true });
  const claims = parseHeroVoiceCanaryClerkClaims(input.sessionClaims, input.authenticatedUserId);
  if (!input.displayName || input.displayName.length > 80 || !/^[^@\s]+@test\.invalid$/u.test(input.email)
    || !Number.isSafeInteger(input.minutesLimit) || input.minutesLimit < 1 || input.minutesLimit > 120) {
    throw new HeroVoiceCanaryAuthError("CANARY_BOOTSTRAP_INPUT_INVALID", 400);
  }
  const ownerHmac = computeHeroVoiceCanaryOwnerHmac(claims);
  return runHeroVoiceCanarySerializedMutation(async () => prisma.$transaction(async (tx) => {
    const [userCount, marker, databaseMarker] = await Promise.all([
      tx.user.count(),
      tx.siteConfig.findUnique({ where: { key: HERO_VOICE_CANARY_BOOTSTRAP_MARKER_KEY } }),
      tx.siteConfig.findUnique({ where: { key: HERO_VOICE_CANARY_DATABASE_MARKER_KEY } }),
    ]);
    if (userCount !== 0 || marker || databaseMarker?.value !== HERO_VOICE_CANARY_DATABASE_MARKER_VALUE) {
      throw new HeroVoiceCanaryAuthError("CANARY_BOOTSTRAP_NOT_PRISTINE", 409);
    }
    const user = await tx.user.create({
      data: {
        clerkId: claims.authSubject,
        name: input.displayName,
        email: input.email,
        plan: "PRO",
        // The isolated marked user still traverses the ordinary shared policy:
        // ADMIN satisfies the existing beta cohort while the exact test.invalid
        // email must independently satisfy the internal tester allowlist.
        role: "ADMIN",
        usageLimit: 0,
        minutesLimit: input.minutesLimit,
        minutesUsed: 0,
        aiAudioMinutesUsed: 0,
        aiTextCallsUsed: 0,
        geminiKeyMode: "byok",
      },
    });
    await tx.creditBalance.create({ data: { userId: user.id, granted: 0, purchased: 0 } });
    await tx.siteConfig.create({
      data: {
        key: HERO_VOICE_CANARY_CREDIT_POLICY_KEY,
        value: heroVoiceCanaryJcsBytes({ version: 1, policy: "isolated-finite-canary-v1", minutesLimit: input.minutesLimit }).toString("utf8"),
      },
    });
    const markerValue = heroVoiceCanarySha256(heroVoiceCanaryJcsBytes({
      version: 1,
      userIdSha256: heroVoiceCanarySha256(user.id),
      ownerHmac,
      creditPolicy: "isolated-finite-canary-v1",
    }));
    await tx.siteConfig.create({ data: { key: HERO_VOICE_CANARY_BOOTSTRAP_MARKER_KEY, value: markerValue } });
    return { userId: user.id, ownerHmac };
  }));
}

export function createHeroVoiceCanaryLoopbackAttestation(): { secret: string; sha256: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, sha256: heroVoiceCanarySha256(secret) };
}

/** Starts the private Next server with an argv-level loopback binding. The
 * unguessable request attestation stays in the parent process; only its digest
 * is inherited by the child. No Host or forwarded header participates. */
export function spawnHeroVoiceCanaryLoopbackHarness(input: { port: number }): Readonly<{
  child: ChildProcess;
  origin: string;
  attestation: string;
}> {
  assertHeroVoiceCanaryIsolatedEnvironment({ requireAuthAttestation: true });
  if (!Number.isSafeInteger(input.port) || input.port < 1_024 || input.port > 65_535) {
    throw new HeroVoiceCanaryAuthError("CANARY_LOOPBACK_PORT_INVALID", 503);
  }
  const nextExecutable = path.resolve(process.cwd(), "node_modules/next/dist/bin/next");
  const metadata = fs.lstatSync(nextExecutable);
  if (!metadata.isFile()) throw new HeroVoiceCanaryAuthError("CANARY_LOOPBACK_BINARY_INVALID", 503);
  const attestation = createHeroVoiceCanaryLoopbackAttestation();
  const child = spawn(process.execPath, [nextExecutable, "start", "-H", "127.0.0.1", "-p", String(input.port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HERO_VOICE_CANARY_LISTEN_HOST: "127.0.0.1",
      HERO_VOICE_CANARY_LOOPBACK_ATTESTATION_SHA256: attestation.sha256,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return Object.freeze({
    child,
    origin: `http://127.0.0.1:${input.port}`,
    attestation: attestation.secret,
  });
}

/** Submit-by-slot trusts only the unguessable parent-process attestation. Host
 * and forwarded headers are explicitly rejected as authority. */
export function assertHeroVoiceCanaryLoopbackSubmitRequest(request: Request): void {
  assertHeroVoiceCanaryIsolatedEnvironment({ requireAuthAttestation: true });
  if (request.headers.has("forwarded") || request.headers.has("x-forwarded-host")
    || request.headers.has("x-forwarded-for") || request.headers.has("x-real-ip")) {
    throw new HeroVoiceCanaryAuthError();
  }
  const supplied = request.headers.get("x-hero-voice-canary-loopback-attestation") ?? "";
  const expectedSha256 = process.env.HERO_VOICE_CANARY_LOOPBACK_ATTESTATION_SHA256 ?? "";
  if (!HEX64.test(expectedSha256) || heroVoiceCanarySha256(supplied) !== expectedSha256) {
    throw new HeroVoiceCanaryAuthError();
  }
  // The server binding is established by the spawning harness; request Host is
  // never used as proof of loopback origin.
}

export function heroVoiceCanarySubmitMac(key: Uint8Array, body: unknown): string {
  return createHmac("sha256", Buffer.from(key)).update(heroVoiceCanaryJcsBytes(body)).digest("hex");
}
