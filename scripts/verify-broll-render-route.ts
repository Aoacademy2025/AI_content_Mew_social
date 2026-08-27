import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import nodeCrypto from "node:crypto";
import ts from "typescript";

import * as brollCoverage from "../src/lib/broll-coverage";
import * as headlineHook from "../src/lib/headline-hook";
import { resolveMediaBaseUrl } from "../src/lib/render/media-base-url";

function compileRenderRoute(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "src/app/api/videos/render/route.ts",
  }).outputText;
}

async function main(): Promise<void> {
  const previousQueueMode = process.env.RENDER_VIA_QUEUE;
  const previousMinuteQuota = process.env.MINUTE_QUOTA;
  const previousCreditsLive = process.env.CREDITS_LIVE;
  process.env.RENDER_VIA_QUEUE = "1";
  process.env.MINUTE_QUOTA = "0";
  process.env.CREDITS_LIVE = "0";

  let enqueueCount = 0;
  let probeSpawnCount = 0;
  let refundCount = 0;
  const telemetryEvents: Array<Record<string, unknown>> = [];

  const fsMock = {
    mkdirSync: () => undefined,
    existsSync: () => false,
    statSync: () => ({ size: 0, isFile: () => false }),
    readFileSync: () => { throw new Error("not found"); },
    writeFileSync: () => undefined,
    readdirSync: () => [] as string[],
    copyFileSync: () => undefined,
  };
  class UnsafeUrlError extends Error {}
  class SupersededError extends Error {}
  class VideoJobFundingConfirmationRequiredError extends Error {}
  class RenderDeployDrainError extends Error {
    async refundOnce(refund: () => Promise<unknown>): Promise<void> { await refund(); }
  }
  const cancelRegistry = {
    activeRenderCancel: new Map(),
    cancelByJobId: new Map(),
    renderJobDoneByUser: new Map(),
    getActiveRenderCount: () => 0,
    incrementActiveRenderCount: () => undefined,
    decrementActiveRenderCount: () => undefined,
    getRenderSlotQueueLength: () => 0,
    activeRemotionBundleNames: () => [] as string[],
  };

  const requireMock = (specifier: string): unknown => {
    if (specifier === "next/server") {
      return {
        NextResponse: {
          json: (body: unknown, init: { status?: number } = {}) => new Response(
            JSON.stringify(body),
            { status: init.status ?? 200, headers: { "Content-Type": "application/json" } },
          ),
        },
      };
    }
    if (specifier === "@/lib/clerk-auth") return { getCurrentUser: async () => ({ id: "route-user" }) };
    if (specifier === "@/lib/notifications") return { createNotification: async () => undefined };
    if (specifier === "@/lib/plan-limits") {
      return {
        limitsForPlan: () => ({ durationSec: 600 }),
        nextPlanFor: () => null,
        PLAN_LABEL: { BUSINESS: "Business" },
      };
    }
    if (specifier === "@/lib/prisma") {
      return {
        prisma: {
          user: { findUnique: async () => ({ plan: "BUSINESS" }) },
          videoJob: { findUnique: async () => null },
        },
      };
    }
    if (specifier === "@/lib/usage-limits") {
      return {
        checkClipQuota: async () => ({ allowed: true }),
        reserveClipUsage: async () => ({ allowed: true }),
      };
    }
    if (specifier === "@/lib/minute-limits") {
      return { checkMinuteQuota: async () => ({ allowed: true }), minutesFromSeconds: () => 1 };
    }
    if (specifier === "@/lib/minute-credits") {
      return {
        reserveMinutesOrCredits: async () => ({ allowed: true, via: "minutes" }),
        refundReservation: async () => { refundCount += 1; },
      };
    }
    if (specifier === "@/lib/credits") {
      return { serializeCreditFunding: () => null };
    }
    if (specifier === "@/lib/quota-error") {
      return { QUOTA_EXCEEDED_CODE: "QUOTA_EXCEEDED", quotaUpgradeUserAction: () => null };
    }
    if (specifier === "@/lib/clip-charge") {
      return { isBurnAlreadyPaid: async () => false, recordChargedClip: async () => undefined };
    }
    if (specifier === "@/lib/broll-rerender") return { rerenderSkipEligible: () => false };
    if (specifier === "@/lib/mcp/video-job") return { parseVideoJobOutput: () => null };
    if (specifier === "@/lib/mcp/video-job-funding") {
      return {
        markTransferredVideoJobFundingRefunded: async () => undefined,
        transferVideoJobFundingToRender: async () => ({ transferred: false }),
        VideoJobFundingConfirmationRequiredError,
      };
    }
    if (specifier === "@/lib/mcp/service-actor") return { resolveServiceVideoJobId: async () => null };
    if (specifier === "path") return nodePath;
    if (specifier === "fs") return fsMock;
    if (specifier === "crypto") return nodeCrypto;
    if (specifier === "@/lib/safe-fetch") {
      return { isSafeFetchUrl: async () => false, assertSafeFetchUrl: async () => undefined, UnsafeUrlError };
    }
    if (specifier === "@/lib/sanitize-caption-style") return { stripDangerousCss: (value: unknown) => value };
    if (specifier === "child_process") {
      return {
        execFileSync: () => undefined,
        spawn: () => {
          probeSpawnCount += 1;
          const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
          proc.stderr = new EventEmitter();
          proc.kill = () => undefined;
          return proc;
        },
      };
    }
    if (specifier === "@/lib/ffmpeg-path") return { getFfmpegPath: () => "ffmpeg" };
    if (specifier === "@/lib/telemetry") {
      return { recordTelemetryEvent: async (_userId: string, event: Record<string, unknown>) => { telemetryEvents.push(event); } };
    }
    if (specifier === "@/lib/broll-coverage") return brollCoverage;
    if (specifier === "@/lib/headline-hook") return headlineHook;
    if (specifier === "@/lib/render/run-render") return { runRender: async () => { throw new Error("must not render"); }, SupersededError };
    if (specifier === "@/lib/render/remotion-public-dir") return { prepareRemotionBundlePublicDir: () => "/tmp/public" };
    if (specifier === "@/lib/render/media-base-url") return { resolveMediaBaseUrl };
    if (specifier === "@/lib/render/job-store") {
      return {
        enqueueRenderJob: async () => { enqueueCount += 1; return { id: "unexpected" }; },
        supersedeScope: async () => 0,
      };
    }
    if (specifier === "@/lib/logo-export.server") return { normalizeTrustedLogoRenderInput: () => null };
    if (specifier === "@/lib/render-deploy-drain") {
      return { assertRenderEnqueueOpen: async () => undefined, RenderDeployDrainError };
    }
    if (specifier === "./cancel-registry") return cancelRegistry;
    if (specifier === "@remotion/renderer") {
      return { makeCancelSignal: () => ({ cancel: () => undefined, cancelSignal: undefined }) };
    }
    throw new Error(`unhandled render route import: ${specifier}`);
  };

  try {
    const source = readFileSync("src/app/api/videos/render/route.ts", "utf8");
    const routeModule = { exports: {} as Record<string, unknown> };
    const factory = new Function("require", "module", "exports", compileRenderRoute(source));
    factory(requireMock, routeModule, routeModule.exports);
    const POST = routeModule.exports.POST as (request: Request) => Promise<Response>;

    const response = await POST(new Request("https://example.test/api/videos/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fps: 30,
        jobScopeId: "broll-route-test",
        shortVideoConfig: {
          bgVideos: [{
            src: "https://example.invalid/unverified.mp4",
            start: 0,
            end: 1,
            sourceIndex: 0,
            clipDuration: 10,
          }],
          requestedBrollWindowCount: "untrusted text",
          keywordPopups: [],
          voiceFile: "https://example.invalid/voice.mp3",
          voiceVolume: 1,
          durationInFrames: 30,
        },
      }),
    }));

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "broll_coverage_incomplete",
      retryable: true,
      metrics: {
        requestedSpanCount: 0,
        availableAssetCount: 0,
        coverageSegmentCount: 0,
        coverageGapCount: 0,
        uncoveredTailSec: 1,
      },
    });
    assert.equal(probeSpawnCount, 0, "unverified external media is rejected without ffmpeg");
    assert.equal(enqueueCount, 0, "typed coverage rejection happens before durable enqueue");
    assert.equal(refundCount, 1, "the route refunds its setup-time reservation");
    const rejected = telemetryEvents.find((event) => event.name === "broll_coverage_rejected");
    assert.ok(rejected);
    assert.deepEqual(rejected?.properties, {
      requestedWindowCount: 1,
      availableAssetCount: 0,
      distinctAssetCount: 0,
      coverageSegmentCount: 0,
      coverageGapCount: 0,
      coverageRepairCount: 1,
      coverageRatio: 0,
      uncoveredTailSec: 1,
      coverageRejected: true,
    });

    console.log("All broll render route checks passed.");
  } finally {
    if (previousQueueMode === undefined) delete process.env.RENDER_VIA_QUEUE;
    else process.env.RENDER_VIA_QUEUE = previousQueueMode;
    if (previousMinuteQuota === undefined) delete process.env.MINUTE_QUOTA;
    else process.env.MINUTE_QUOTA = previousMinuteQuota;
    if (previousCreditsLive === undefined) delete process.env.CREDITS_LIVE;
    else process.env.CREDITS_LIVE = previousCreditsLive;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
