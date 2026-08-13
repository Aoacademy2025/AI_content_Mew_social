import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DefinitivePreviewRequestError,
  postPreviewWithRecovery,
  recoverPreviewByRequestId,
} from "../src/app/(dashboard)/brands/_components/preview-recovery";
import {
  clearPendingBrandPreviewOperation,
  readPendingBrandPreviewOperation,
  writePendingBrandPreviewOperation,
} from "../src/lib/brand-preview-client-state";

type AdmitBrandLookGeneration = typeof import(
  "../src/lib/brand-look-preview-admission.server"
)["admitBrandLookGeneration"];

let admitBrandLookGeneration: AdmitBrandLookGeneration;

async function verifyPublicRouteAdmission() {
  let costChecks = 0;
  const result = await admitBrandLookGeneration(
    { userId: "public-route-user", role: "ADMIN", imageCount: 3, purpose: "preview" },
    {
      checkFunding: async () => ({ ok: true, fundingSource: "credits" as const }),
      checkRate: async () => ({ ok: true as const }),
      describeOffer: () => ({
        available: true,
        providerRoute: "runpod-public",
        providerEndpoint: "z-image-turbo",
      }),
      getCost: async () => {
        costChecks += 1;
        return { admitted: true };
      },
    },
  );

  assert.deepEqual(result, { ok: true }, "the production RunPod Public route must admit Brand Look Preview");
  assert.equal(
    costChecks,
    0,
    "the private-endpoint billing snapshot must not gate the fixed-price RunPod Public route",
  );
}

async function verifyDefinitiveAdmissionContract() {
  const result = await admitBrandLookGeneration(
    { userId: "unavailable-route-user", role: "ADMIN", imageCount: 3, purpose: "preview" },
    {
      checkFunding: async () => ({ ok: true, fundingSource: "credits" as const }),
      checkRate: async () => ({ ok: true as const }),
      describeOffer: () => ({
        available: false,
        providerRoute: null,
        providerEndpoint: null,
      }),
      getCost: async () => { throw new Error("an unavailable offer must stop before billing"); },
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 503);
  assert.equal(
    result.body.definitive,
    true,
    "pre-materialization admission failures must tell the client no durable batch can exist",
  );
}

async function verifyDefinitiveServerRejection() {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let fetchCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      error: "hero_image_cost_guard",
      definitive: true,
      message: "ระบบพักงานใหม่เพื่อควบคุมต้นทุนภาพ",
    }), { status: 503, headers: { "content-type": "application/json" } });
  };

  try {
    await assert.rejects(
      postPreviewWithRecovery("/api/brand-library/preview", {}, "definitive-503", () => {}),
      (error: unknown) => error instanceof DefinitivePreviewRequestError
        && error.message === "ระบบพักงานใหม่เพื่อควบคุมต้นทุนภาพ",
      "a pre-materialization 503 must preserve its actionable reason and retire the local request",
    );
    assert.equal(fetchCalls, 1, "a definitive response must not poll for a batch the server did not create");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function verifyMissingBatchRetiresPendingOperation() {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let now = Date.parse("2026-08-13T06:15:41.000Z");
  Date.now = () => now;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback: () => void, ms: number) {
        now += ms;
        callback();
        return 1;
      },
      clearTimeout() {},
    },
  });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "PREVIEW_NOT_FOUND" }),
    { status: 404, headers: { "content-type": "application/json" } },
  );

  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const operation = {
    version: 2 as const,
    kind: "preview" as const,
    userId: "preview-reporter",
    requestId: "623cb1c8-bfa3-496c-a9aa-0a75a2c1254c",
    surface: {
      profileId: null,
      payloadJson: "{}",
      projectId: null,
      preflightId: null,
      videoJobId: null,
    },
    createdAt: new Date(now).toISOString(),
    autoResumeAttemptedAt: new Date(now).toISOString(),
  };
  writePendingBrandPreviewOperation(storage, operation);

  try {
    let caught: unknown;
    try {
      await recoverPreviewByRequestId(operation.requestId, () => {});
    } catch (error) {
      caught = error;
      // This is the real BrandLibraryClient catch-path. Only a definitive
      // response may retire the stored idempotency key safely.
      if (error instanceof DefinitivePreviewRequestError) {
        clearPendingBrandPreviewOperation(storage, operation.userId, operation.requestId);
      }
    }
    assert.ok(caught instanceof DefinitivePreviewRequestError, "30 seconds of 404s are definitive");
    assert.equal(
      readPendingBrandPreviewOperation(storage, operation.userId, new Date(now)),
      null,
      "an orphaned preview request must not survive the recovery window",
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "brand-preview-route-recovery-"));
  process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
  ({ admitBrandLookGeneration } = await import("../src/lib/brand-look-preview-admission.server"));
  try {
    await verifyPublicRouteAdmission();
    await verifyDefinitiveAdmissionContract();
    await verifyDefinitiveServerRejection();
    await verifyMissingBatchRetiresPendingOperation();
    console.log("Brand preview public-route and recovery regression checks passed.");
  } finally {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
