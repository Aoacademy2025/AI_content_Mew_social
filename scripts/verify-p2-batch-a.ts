import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RenderingScreen } from "../src/app/(dashboard)/video-editor/_v2/RenderingScreen";
import type { V2JobState } from "../src/app/(dashboard)/video-editor/_v2/useV2Job";
import {
  editorDashboardJobHref,
  readProjectScopedEditorJobPointer,
  resolveDashboardEditorJobPointer,
  selectDashboardEditorJobPointer,
} from "../src/lib/editor-dashboard-job";

// Next's JSX transform supplies this in production; the direct tsx verifier uses
// the classic transform, so expose the same runtime at the test boundary.
Object.assign(globalThis, { React });

const queuedJob: V2JobState = {
  phase: "rendering",
  jobId: "queued-job",
  jobType: "create",
  projectId: "project-a",
  currentStep: null,
  progress: 0,
  queuePosition: 4,
  errorMessage: null,
  errorCode: null,
  errorProvider: null,
  output: null,
  mediaState: null,
};

const queuedMarkup = renderToStaticMarkup(React.createElement(RenderingScreen, {
  job: queuedJob,
  hasAvatar: false,
  onCancel: () => undefined,
}));
assert.match(
  queuedMarkup,
  /อยู่ในคิว #4 — เริ่มอัตโนมัติเมื่อถึงลำดับ/,
  "Editor V2 shows the exact 1-based queue position returned by the job API",
);
assert.match(
  queuedMarkup,
  /role="status"[^>]*aria-live="polite"/,
  "queue progress is announced as a polite live status",
);

const unknownPositionMarkup = renderToStaticMarkup(React.createElement(RenderingScreen, {
  job: { ...queuedJob, queuePosition: null },
  hasAvatar: false,
  onCancel: () => undefined,
}));
assert.match(
  unknownPositionMarkup,
  /อยู่ในคิว — เริ่มอัตโนมัติเมื่อถึงลำดับ/,
  "Editor V2 keeps an honest queue fallback while the exact position is unavailable",
);

const serverPointer = selectDashboardEditorJobPointer([
  {
    id: "recent-complete-project",
    status: "post",
    activeJobId: "done-job",
    activeExportJobId: null,
  },
  {
    id: "running-project",
    status: "rendering",
    activeJobId: "queued-job",
    activeExportJobId: null,
  },
]);
assert.deepEqual(
  serverPointer,
  { projectId: "running-project", jobId: "queued-job" },
  "dashboard prioritizes an in-flight project over a more recently opened completed project",
);
assert.equal(
  editorDashboardJobHref(serverPointer),
  "/video-editor?ui=v2&projectId=running-project",
  "dashboard job CTA opens the exact project that owns the selected job",
);

const storageValues = new Map([
  ["editor-v2-project-account", "account-a"],
  ["editor-v2-project-id:account-a", "project-a"],
  ["editor-v2-job:project-a", "scoped-job-a"],
  ["editor-v2-job", "stale-global-job"],
]);
const storagePointer = readProjectScopedEditorJobPointer({
  getItem: (key: string) => storageValues.get(key) ?? null,
});
assert.deepEqual(
  storagePointer,
  { projectId: "project-a", jobId: "scoped-job-a" },
  "rolling-deploy fallback reads the current account's project-scoped job instead of a stale global job",
);

function verifyRenderConfigContract(): void {
  const probe = spawnSync(process.execPath, ["-e", `
    process.env.RENDER_CONCURRENCY = "9";
    process.env.RENDER_LOW_RESOURCE = "1";
    process.env.RENDER_OFFTHREAD_CACHE_MB = "999";
    process.env.RENDER_JPEG_QUALITY = "12";
    process.env.STOCK_NORMALIZE_CONCURRENCY = "4";
    process.env.STOCK_NORMALIZE_PRESET = "slow";
    const config = require("./ecosystem.config.js");
    const pick = (env = {}) => Object.fromEntries([
      "RENDER_CONCURRENCY",
      "RENDER_LOW_RESOURCE",
      "RENDER_OFFTHREAD_CACHE_MB",
      "RENDER_JPEG_QUALITY",
      "STOCK_NORMALIZE_CONCURRENCY",
      "STOCK_NORMALIZE_PRESET",
    ].map((key) => [key, env[key] ?? null]));
    const app = config.apps.find((entry) => entry.name === "ai-content");
    const worker = config.apps.find((entry) => entry.name === "render-worker");
    console.log(JSON.stringify({
      app: pick(app.env),
      appProduction: pick(app.env_production),
      worker: pick(worker.env),
    }));
  `], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const actual = JSON.parse(probe.stdout) as Record<string, unknown>;
  const renderRuntime = {
    RENDER_CONCURRENCY: "3",
    RENDER_LOW_RESOURCE: "0",
    RENDER_OFFTHREAD_CACHE_MB: "128",
    RENDER_JPEG_QUALITY: "90",
    STOCK_NORMALIZE_CONCURRENCY: "1",
    STOCK_NORMALIZE_PRESET: "ultrafast",
  };
  assert.deepEqual(actual.app, renderRuntime,
    "web/stock entrypoint receives the reviewed render runtime profile");
  assert.deepEqual(actual.appProduction, renderRuntime,
    "--env production cannot shadow the reviewed render runtime profile");
  assert.deepEqual(actual.worker, {
    ...renderRuntime,
    STOCK_NORMALIZE_CONCURRENCY: null,
    STOCK_NORMALIZE_PRESET: null,
  }, "render workers receive the same render profile regardless of caller shell env");
}

verifyRenderConfigContract();

function verifyDeployReloadContract(): void {
  const deploy = readFileSync("deploy/deploy.sh", "utf8");
  assert.match(
    deploy,
    /restart_from_ecosystem\(\)[\s\S]*pm2 restart ecosystem\.config\.js --only "\$process_name"[\s\S]*pm2 start ecosystem\.config\.js --only "\$process_name"/,
    "deploy reloads existing processes and starts missing processes from the checked-in ecosystem file",
  );
  for (const processName of ["$APP_NAME", "$WORKER_NAME", "$RENDER_WORKER_NAME"]) {
    assert.ok(
      deploy.includes(`restart_from_ecosystem "${processName}"`),
      `deploy uses the ecosystem reload contract for ${processName}`,
    );
  }
  assert.doesNotMatch(
    deploy,
    /pm2 restart "\$(?:APP_NAME|WORKER_NAME)"|pm2 restart render-worker/,
    "no core process keeps stale PM2 env through a name-only restart",
  );
}

verifyDeployReloadContract();

async function verifyPointerResolution(): Promise<void> {
  const resolvedServerPointer = await resolveDashboardEditorJobPointer({
    fetchProjects: async () => ({
      ok: true,
      async json() {
        return {
          projects: [{
            id: "server-project",
            status: "rendering",
            activeJobId: "server-job",
            activeExportJobId: null,
          }],
        };
      },
    }),
    storage: { getItem: (key: string) => storageValues.get(key) ?? null },
  });
  assert.deepEqual(
    resolvedServerPointer,
    { projectId: "server-project", jobId: "server-job" },
    "server-owned project/job pointers override browser fallback state",
  );

  const resolvedFallbackPointer = await resolveDashboardEditorJobPointer({
    fetchProjects: async () => ({ ok: false, async json() { return {}; } }),
    storage: { getItem: (key: string) => storageValues.get(key) ?? null },
  });
  assert.deepEqual(
    resolvedFallbackPointer,
    { projectId: "project-a", jobId: "scoped-job-a" },
    "a transient project-list failure keeps the rolling-deploy project-scoped fallback usable",
  );
}

verifyPointerResolution()
  .then(() => console.log("p2-batch-a: all checks passed"))
  .catch((error) => { console.error(error); process.exit(1); });
