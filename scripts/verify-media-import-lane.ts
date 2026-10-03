// Task 12 (PR-B, docs/plans/2026-10-03-mcp-edit-before-export.md, G23/G24/G25/G28, ADR 0065):
// the Media Import lane inside mcp-video-worker — fair-share claiming, the deadline watchdog,
// file cleanup on every terminal path, and independence from the video-job slots.
//
// Covers, against a throwaway SQLite file and a private TMPDIR:
//   A. claiming: expired rows are never claimed (security review F3), the claim resets the
//      deadline, oldest first per user, round-robin across users, one lane slot per user,
//      a still-streaming upload is never claimed and does not count as "in the lane".
//   B. two lane instances never double-claim: two real processes on one SQLite file, and two
//      in-process lanes processing the same queue (every URL fetched exactly once).
//   C. the lane end to end (real ffmpeg/ffprobe through T9's pipeline, a fake fetch for url
//      rows): ready/failed with a fixed code, staged + temp files gone on every path, one
//      user's slow import does not block another user's, deadline expiry, a restart
//      mid-processing recovered by the watchdog (which also deletes the files), the startup
//      sweeps, token pruning, no raw error / IP / path / URL in rows or logs, and the
//      production fetch guard is the default.
//   D. video-job slots are unaffected: a queued VideoJob is claimed while both lane slots are
//      busy, the worker's video loop is untouched, and the REAL worker process boots, runs the
//      lane (startup sweep, watchdog, a real import) and shuts down cleanly.
//   E. wiring: package.json + CI (the G24 step, which installs ffmpeg).
//
// Needs real ffmpeg + ffprobe. Run: node --conditions=react-server --import tsx scripts/verify-media-import-lane.ts
import { execFileSync, execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAIM_CHILD_FLAG = "--claim-child";
const ROOT = path.resolve(__dirname, "..");
const MINUTE = 60_000;

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}
async function section(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  try {
    await body();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name} threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 30_000, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

// ── child mode: one lane process racing for claims ─────────────────────────────────────────

async function runClaimChild(): Promise<void> {
  const spec = JSON.parse(process.argv[3] ?? "{}") as { goFile: string; loops: number };
  const lane = await import("../src/lib/media-import/lane");
  const { prisma } = await import("../src/lib/prisma");
  // Connect and warm every query the claim runs before the barrier, so both start racing at once.
  await prisma.$queryRawUnsafe("SELECT 1");
  await prisma.mediaImport.findMany({ where: { status: "pending" }, take: 1 });
  await prisma.mediaImport.groupBy({ by: ["userId"], where: { status: "processing" }, _count: { _all: true } });
  await prisma.mediaImport.updateMany({ where: { id: "warm-up-no-such-row" }, data: { status: "pending" } });
  fs.writeFileSync(`${spec.goFile}.ready-${process.pid}`, "ready");
  while (!fs.existsSync(spec.goFile)) await sleep(2);
  const claimed: string[] = [];
  let errors = 0;
  await Promise.all(Array.from({ length: spec.loops }, async () => {
    for (;;) {
      let row: Awaited<ReturnType<typeof lane.claimNextMediaImport>>;
      try {
        row = await lane.claimNextMediaImport();
      } catch {
        errors += 1; // a busy database is retried, exactly like the lane's next poll
        if (errors > 50) throw new Error("too many claim errors");
        await sleep(5);
        continue;
      }
      if (!row) return;
      claimed.push(row.id);
    }
  }));
  process.stdout.write(`RESULT ${JSON.stringify({ claimed, errors })}\n`);
  await prisma.$disconnect();
}

function runClaimChildren(count: number, goFile: string): Promise<Array<{ claimed: string[]; errors: number }>> {
  const children = Array.from({ length: count }, () => new Promise<{ claimed: string[]; errors: number }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", __filename, CLAIM_CHILD_FLAG, JSON.stringify({ goFile, loops: 3 })],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("exit", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (code !== 0 || !line) reject(new Error(`claim child exited ${code}: ${err.slice(-2000)}`));
      else resolve(JSON.parse(line.slice("RESULT ".length)));
    });
  }));
  const barrier = setInterval(() => {
    const ready = fs.readdirSync(path.dirname(goFile)).filter((n) => n.startsWith(`${path.basename(goFile)}.ready-`));
    if (ready.length >= count) {
      fs.writeFileSync(goFile, "go");
      clearInterval(barrier);
    }
  }, 5);
  return Promise.all(children).finally(() => clearInterval(barrier));
}

// ── parent ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "media-import-lane-")));
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true })); // also on a setup failure
  // Private TMPDIR: the staging dir (T11) and the fetch temp dir (T10) both live under
  // os.tmpdir(), so this keeps the real ones untouched — for this process and the worker child.
  const privateTmp = path.join(tmp, "tmpdir");
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  process.env.TMPDIR = privateTmp;
  const dbPath = path.join(tmp, "media-import-lane.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const lane = await import("../src/lib/media-import/lane");
  const imports = await import("../src/lib/media-import/imports");
  const staging = await import("../src/lib/media-import/upload-staging");
  const fetchMod = await import("../src/lib/media-import/fetch");
  const { claimNextRunnableJob } = await import("../src/lib/mcp/video-job");
  const { prisma } = await import("../src/lib/prisma");
  const { getFfmpegPath } = await import("../src/lib/ffmpeg-path");
  const { MAX_BROLL_IMAGE_BYTES, MAX_BROLL_VIDEO_BYTES } = await import("../src/lib/media-import/broll-pipeline");

  check("os.tmpdir() is the private test dir", os.tmpdir() === privateTmp, os.tmpdir());
  const stagingDir = staging.mediaImportStagingDir();
  const tempDir = fetchMod.mediaImportTempDir();
  const stocksDir = path.join(tmp, "stocks");
  fs.mkdirSync(stocksDir, { recursive: true });
  const ensurePrivateDir = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  };
  ensurePrivateDir(stagingDir);
  ensurePrivateDir(tempDir);

  // Presenter outputs always land in <cwd>/public/renders (upload-avatar's dir); remove them.
  const rendersOutputs = new Set<string>();
  const rendersDir = path.join(ROOT, "public", "renders");
  const listPresenterOutputs = () => (fs.existsSync(rendersDir) ? fs.readdirSync(rendersDir).filter((n) => n.startsWith("presenter-import-")) : []);
  const presenterOutputsBefore = new Set(listPresenterOutputs());
  const repoStocksDir = path.join(ROOT, "stocks");
  const listRepoStocks = () => (fs.existsSync(repoStocksDir) ? fs.readdirSync(repoStocksDir).filter((n) => n.startsWith("broll-upload-")) : []);
  const repoStocksBefore = new Set(listRepoStocks());

  const now = new Date();
  async function makeUser(id: string, plan: "PRO" | "FREE" = "PRO") {
    await prisma.user.create({
      data: {
        id, name: id, email: `${id}@lane.test`, plan,
        minutesLimit: 80, minutesUsed: 0, usagePeriodStartedAt: now, trialEndsAt: null,
        usageLimit: 100, usageCount: 0,
        ...(plan === "PRO"
          ? { subStatus: "active", stripeSubscriptionId: `sub_${id}`, planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * MINUTE) }
          : {}),
      },
    });
    if (plan === "PRO") {
      await prisma.payment.create({
        data: { userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900, status: "PAID", periodDays: 30, paidAt: now },
      });
    }
  }
  for (const id of ["ua", "ub", "uc", "ud"]) await makeUser(id);

  // Fixtures (real media, tiny).
  const ff = (args: string[]) => execFileSync(getFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const fixture = (name: string) => path.join(tmp, name);
  ff(["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", fixture("still.png")]);
  ff(["-f", "lavfi", "-i", "testsrc=size=360x640:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("portrait.mp4")]);
  ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture("landscape.mp4")]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", fixture("audio.m4a")]);
  const png = fs.readFileSync(fixture("still.png"));
  const portrait = fs.readFileSync(fixture("portrait.mp4"));
  const landscape = fs.readFileSync(fixture("landscape.mp4"));
  const m4a = fs.readFileSync(fixture("audio.m4a"));
  const garbage = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n");

  // ── fake fetch: honours the T10 contract (a 0600 file in mediaImportTempDir(), caller owns it) ──
  type Served = { bytes: Buffer; kind: "image" | "video"; ext: "jpg" | "png" | "webp" | "mp4" | "webm" };
  type Behavior = { serve: Served; gate?: Promise<void> } | { error: Error; gate?: Promise<void> };
  const behaviors = new Map<string, Behavior>();
  const fetchCalls: Array<{ url: string; accept: Record<string, number | undefined>; deadlineMs?: number; at: number }> = [];
  const fakeFetch = async (url: string, options: { accept: Partial<Record<"image" | "video", number>>; deadlineMs?: number; tmpDir?: string }) => {
    fetchCalls.push({ url, accept: { ...options.accept }, deadlineMs: options.deadlineMs, at: Date.now() });
    const behavior = behaviors.get(url);
    if (!behavior) throw new fetchMod.MediaFetchError("fetch_failed");
    if (behavior.gate) await behavior.gate;
    if ("error" in behavior) throw behavior.error;
    ensurePrivateDir(tempDir);
    const file = path.join(tempDir, `media-import-${randomUUID()}.${behavior.serve.ext}`);
    fs.writeFileSync(file, behavior.serve.bytes, { mode: 0o600 });
    return { path: file, kind: behavior.serve.kind, ext: behavior.serve.ext, mime: "application/octet-stream", bytes: behavior.serve.bytes.length };
  };
  const serveVideo = (bytes: Buffer): Served => ({ bytes, kind: "video", ext: "mp4" });
  const servePng: Served = { bytes: png, kind: "image", ext: "png" };

  // ── log capture: every lane line, plus anything printed on the console meanwhile ──
  const logs: string[] = [];
  const logger = { info: (line: string) => { logs.push(line); }, error: (line: string) => { logs.push(line); } };
  const realConsole = { log: console.log, error: console.error, warn: console.warn };
  function captureConsole(): () => string[] {
    const captured: string[] = [];
    const grab = (orig: (...args: unknown[]) => void) => (...args: unknown[]) => {
      captured.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
      orig(...args);
    };
    console.log = grab(realConsole.log);
    console.error = grab(realConsole.error);
    console.warn = grab(realConsole.warn);
    return () => {
      console.log = realConsole.log;
      console.error = realConsole.error;
      console.warn = realConsole.warn;
      return captured;
    };
  }

  // ── row helpers ──
  let seq = 0;
  async function addImport(userId: string, purpose: "broll_image" | "broll_video" | "presenter", opts: {
    url?: string; bytes?: Buffer; status?: string; deadlineAt?: Date; createdAt?: Date; claimedAt?: Date | null;
  } = {}) {
    seq += 1;
    const row = await prisma.mediaImport.create({
      data: {
        userId,
        purpose,
        source: opts.url !== undefined ? "url" : "upload",
        sourceUrl: opts.url ?? null,
        status: opts.status ?? "pending",
        deadlineAt: opts.deadlineAt ?? new Date(Date.now() + imports.IMPORT_DEADLINE_MS),
        createdAt: opts.createdAt ?? new Date(now.getTime() - 60 * MINUTE + seq * 1000),
        claimedAt: opts.claimedAt ?? null,
      },
    });
    if (opts.bytes) {
      ensurePrivateDir(stagingDir);
      fs.writeFileSync(staging.stagedUploadPath(row.id), opts.bytes, { mode: 0o600 });
    }
    return row;
  }
  const rowOf = (id: string) => prisma.mediaImport.findUniqueOrThrow({ where: { id } });
  const stagedExists = (id: string) => fs.existsSync(staging.stagedUploadPath(id));
  const tempFiles = () => (fs.existsSync(tempDir) ? fs.readdirSync(tempDir).filter((n) => n.startsWith("media-import-")) : []);
  const stocksFiles = () => fs.readdirSync(stocksDir).filter((n) => !n.startsWith("."));
  async function reset() {
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
    await prisma.videoJob.deleteMany({});
    behaviors.clear();
    fetchCalls.length = 0;
    for (const dir of [stagingDir, tempDir]) {
      if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
  function newLane(extra: Record<string, unknown> = {}) {
    return lane.createMediaImportLane({ pollMs: 20, watchdogMs: 60 * MINUTE, stocksDir, fetchMedia: fakeFetch, log: logger, ...extra });
  }
  const recordOutput = (resultSrc: string | null) => {
    if (resultSrc?.startsWith("/api/renders/")) rendersOutputs.add(path.join(rendersDir, path.basename(resultSrc)));
  };
  const allCodes = new Set<string>(lane.MEDIA_IMPORT_LANE_ERROR_CODES);

  try {
    // ── A. claiming ────────────────────────────────────────────────────────────────────────
    await section("A1) rows past deadlineAt are never claimed (F3); the claim resets the deadline (T11 review A4)", async () => {
      await reset();
      const t = new Date(Date.now() + 5 * MINUTE);
      const atDeadline = await addImport("ua", "broll_image", { deadlineAt: t });
      const pastDeadline = await addImport("ub", "broll_image", { deadlineAt: new Date(t.getTime() - 1000) });
      check("a row whose deadline == now is not claimed", (await lane.claimNextMediaImport(t)) === null);
      check("…it stays pending, untouched", (await rowOf(atDeadline.id)).status === "pending" && (await rowOf(pastDeadline.id)).status === "pending");
      const live = await addImport("uc", "broll_image", { deadlineAt: new Date(t.getTime() + 1) });
      const claimed = await lane.claimNextMediaImport(t);
      check("a row 1 ms inside its deadline is claimed", claimed?.id === live.id, JSON.stringify(claimed));
      const after = await rowOf(live.id);
      check("claim: pending → processing, claimedAt = now", after.status === "processing" && after.claimedAt?.getTime() === t.getTime());
      check("claim: deadlineAt reset to now + IMPORT_DEADLINE_MS (10 min of lane time, not what is left of the queue wait)", after.deadlineAt.getTime() === t.getTime() + imports.IMPORT_DEADLINE_MS);
      check("claimed row carries what the lane needs", claimed?.purpose === "broll_image" && claimed?.source === "upload" && claimed?.userId === "uc"
        && claimed?.deadlineAt.getTime() === after.deadlineAt.getTime());
      check("nothing else is claimable at that instant", (await lane.claimNextMediaImport(t)) === null);
      check("expired rows still pending (left to the watchdog)", (await rowOf(atDeadline.id)).status === "pending" && (await rowOf(pastDeadline.id)).status === "pending");
    });

    await section("A2) only `pending` is claimable — a streaming upload, ready and failed rows never are", async () => {
      await reset();
      await addImport("ua", "broll_video", { status: "processing" }); // bytes still streaming in (claimedAt null)
      await addImport("ub", "broll_video", { status: "ready" });
      await addImport("uc", "broll_video", { status: "failed" });
      check("no claim", (await lane.claimNextMediaImport()) === null);
      const pend = await addImport("ua", "broll_video");
      check("a streaming upload does not count as 'in the lane' for its user", (await lane.claimNextMediaImport())?.id === pend.id);
    });

    await section("A3) fair share: oldest first per user, one lane slot per user, round-robin across users", async () => {
      await reset();
      const base = Date.now() - 30 * MINUTE;
      const at = (s: number) => new Date(base + s * 1000);
      const a1 = await addImport("ua", "broll_image", { createdAt: at(1) });
      const a2 = await addImport("ua", "broll_image", { createdAt: at(2) });
      const a3 = await addImport("ua", "broll_image", { createdAt: at(3) });
      const b1 = await addImport("ub", "broll_image", { createdAt: at(4) });
      const c1 = await addImport("uc", "broll_image", { createdAt: at(5) });
      const order: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const row = await lane.claimNextMediaImport();
        if (row) order.push(row.id);
      }
      check("claims: A's oldest, then B, then C — A's backlog waits while A has one in the lane", JSON.stringify(order) === JSON.stringify([a1.id, b1.id, c1.id]), JSON.stringify(order));
      check("a 4th claim finds nothing (every user with work already holds a slot)", order.length === 3);
      await prisma.mediaImport.update({ where: { id: a1.id }, data: { status: "ready" } });
      check("A's slot frees → A's next-oldest (oldest first per user)", (await lane.claimNextMediaImport())?.id === a2.id);
      check("A3 still pending", (await rowOf(a3.id)).status === "pending");

      // Round-robin: A was served most recently, D never — D goes first even though A's row is older.
      await reset();
      const ra1 = await addImport("ua", "broll_image", { createdAt: at(1) });
      const ra2 = await addImport("ua", "broll_image", { createdAt: at(2) });
      const rd1 = await addImport("ud", "broll_image", { createdAt: at(3) });
      const first = await lane.claimNextMediaImport();
      check("round-robin: oldest overall first", first?.id === ra1.id);
      await prisma.mediaImport.update({ where: { id: ra1.id }, data: { status: "ready" } });
      await sleep(5);
      check("round-robin: then the least-recently-served user (D), not A's older row", (await lane.claimNextMediaImport())?.id === rd1.id);
      await prisma.mediaImport.update({ where: { id: rd1.id }, data: { status: "ready" } });
      check("round-robin: then A again", (await lane.claimNextMediaImport())?.id === ra2.id);
    });

    // ── B. two lane instances never double-claim ───────────────────────────────────────────
    await section("B1) two real processes claiming one queue never double-claim", async () => {
      const N = 150;
      for (let i = 0; i < N; i += 1) {
        const uid = `claim-${i}`;
        await prisma.user.create({ data: { id: uid, name: uid, email: `${uid}@lane.test` } });
      }
      // The no-double-claim checks are hard on every attempt; interleaving (both processes won
      // some rows) is what proves the race was real, so an attempt where one process happened to
      // win everything is repeated (at most 3 attempts).
      let interleaved = false;
      for (let attempt = 1; attempt <= 3 && !interleaved; attempt += 1) {
        await reset();
        const many: string[] = [];
        for (let i = 0; i < N; i += 1) many.push((await addImport(`claim-${i}`, "broll_image")).id);
        const goFile = path.join(tmp, `go-${randomUUID()}`);
        const results = await runClaimChildren(2, goFile);
        const all = results.flatMap((r) => r.claimed);
        check(`attempt ${attempt}: every row claimed exactly once (${N} claims, ${N} distinct ids)`, all.length === N && new Set(all).size === N, `claims=${all.length} distinct=${new Set(all).size}`);
        check(`attempt ${attempt}: only rows from the queue`, all.every((id) => many.includes(id)));
        const rows = await prisma.mediaImport.findMany({ where: { id: { in: many } } });
        check(`attempt ${attempt}: all ${N} rows processing with a claimedAt`, rows.every((r) => r.status === "processing" && r.claimedAt));
        for (const r of results) console.log(`        attempt ${attempt}: process claimed ${r.claimed.length}, transient errors ${r.errors}`);
        interleaved = results.every((r) => r.claimed.length > 0);
      }
      check("both processes claimed in one race (they really interleaved)", interleaved);
    });

    await section("B2) two in-process lanes on one queue: every import fetched and finished exactly once", async () => {
      await reset();
      const urls: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const uid = `claim-${i}`;
        const url = `https://b2.example/${i}.mp4`;
        behaviors.set(url, { serve: serveVideo(landscape) });
        urls.push(url);
        await addImport(uid, "broll_video", { url });
      }
      const l1 = newLane();
      const l2 = newLane();
      l1.start();
      l2.start();
      const done = await waitFor(async () => (await prisma.mediaImport.count({ where: { status: "ready" } })) === 8, 90_000);
      await Promise.all([l1.stop(), l2.stop()]);
      check("all 8 imports ready", done);
      const perUrl = urls.map((u) => fetchCalls.filter((c) => c.url === u).length);
      check("each URL fetched exactly once", perUrl.every((n) => n === 1), perUrl.join(","));
      check("no staged or temp file left", fs.readdirSync(stagingDir).length === 0 && tempFiles().length === 0);
      for (const f of stocksFiles()) fs.rmSync(path.join(stocksDir, f), { force: true });
    });

    // ── C. the lane end to end ─────────────────────────────────────────────────────────────
    await section("C1) through T9's real pipeline: ready with resultSrc, or failed with a fixed code; files gone either way", async () => {
      await reset();
      const stopCapture = captureConsole();
      const upImg = await addImport("ua", "broll_image", { bytes: png });
      const urlVid = await addImport("ub", "broll_video", { url: "https://media.example/v.mp4" });
      behaviors.set("https://media.example/v.mp4", { serve: serveVideo(landscape) });
      const urlPres = await addImport("uc", "presenter", { url: "https://media.example/p.mp4" });
      behaviors.set("https://media.example/p.mp4", { serve: serveVideo(portrait) });
      const l = newLane();
      l.start();
      const done = await waitFor(async () => (await prisma.mediaImport.count({ where: { status: { in: ["ready", "failed"] } } })) === 3, 60_000);
      check("three imports finished", done);
      const img = await rowOf(upImg.id);
      check("upload image → ready, Ken Burns clip in stocks, 5000 ms", img.status === "ready" && /^\/api\/stocks\/broll-upload-[\w-]+\.mp4$/.test(img.resultSrc ?? "") && img.durationMs === 5000
        && fs.existsSync(path.join(stocksDir, path.basename(img.resultSrc ?? "x"))), JSON.stringify(img));
      const vid = await rowOf(urlVid.id);
      check("url video → ready, normalized clip in stocks with its duration", vid.status === "ready" && (vid.resultSrc ?? "").startsWith("/api/stocks/") && (vid.durationMs ?? 0) > 500, JSON.stringify(vid));
      const pres = await rowOf(urlPres.id);
      recordOutput(pres.resultSrc);
      check("url presenter → ready, /api/renders/presenter-import-…mp4 with its duration", pres.status === "ready" && /^\/api\/renders\/presenter-import-[\w-]+\.mp4$/.test(pres.resultSrc ?? "") && (pres.durationMs ?? 0) > 500, JSON.stringify(pres));
      check("ready rows carry no errorCode", [img, vid, pres].every((r) => r.errorCode === null));

      // Failures: each with its code, no output, no file.
      const before = stocksFiles().length;
      const landscapePres = await addImport("ua", "presenter", { url: "https://media.example/landscape.mp4" });
      behaviors.set("https://media.example/landscape.mp4", { serve: serveVideo(landscape) });
      const playlist = await addImport("ub", "broll_video", { bytes: garbage });
      const audioOnly = await addImport("uc", "broll_video", { url: "https://media.example/a.m4a" });
      behaviors.set("https://media.example/a.m4a", { serve: serveVideo(m4a) });
      const audioPres = await addImport("ud", "presenter", { url: "https://media.example/a2.m4a" });
      behaviors.set("https://media.example/a2.m4a", { serve: serveVideo(m4a) });
      const notPublic = await addImport("ua", "broll_image", { url: "https://media.example/private.png" });
      behaviors.set("https://media.example/private.png", { error: new fetchMod.MediaFetchError("url_not_public") });
      const missingStage = await addImport("ub", "broll_image"); // upload row with no staged bytes
      const allIds = [landscapePres.id, playlist.id, audioOnly.id, audioPres.id, notPublic.id, missingStage.id];
      const finished = await waitFor(async () => (await prisma.mediaImport.count({ where: { id: { in: allIds }, status: "failed" } })) === allIds.length, 60_000);
      await l.stop();
      const captured = stopCapture();
      check("every failure path finished as failed", finished);
      const code = async (id: string) => (await rowOf(id)).errorCode;
      check("landscape presenter → not_portrait", (await code(landscapePres.id)) === "not_portrait");
      check("playlist bytes as an upload → unsupported_media (never reaches ffmpeg)", (await code(playlist.id)) === "unsupported_media");
      check("audio-only m4a as B-roll video → refused (no video stream)", ["unsupported_type", "probe_failed"].includes(String(await code(audioOnly.id))), String(await code(audioOnly.id)));
      check("audio-only m4a as presenter → refused", ["unsupported_type", "probe_failed", "not_portrait"].includes(String(await code(audioPres.id))), String(await code(audioPres.id)));
      check("fetch refusal → its own G23 code (url_not_public)", (await code(notPublic.id)) === "url_not_public");
      check("upload row without staged bytes → upload_missing", (await code(missingStage.id)) === "upload_missing");
      const failedRows = await prisma.mediaImport.findMany({ where: { id: { in: allIds } } });
      check("failed rows have no resultSrc / durationMs", failedRows.every((r) => r.resultSrc === null && r.durationMs === null));
      check("finished rows no longer hold the agent's link (sourceUrl cleared)",
        (await prisma.mediaImport.count({ where: { sourceUrl: { not: null }, status: { in: ["ready", "failed"] } } })) === 0);
      check("no new output for any failure", stocksFiles().length === before, `${before} → ${stocksFiles().length}`);
      check("no staged file left (staging dir empty)", fs.readdirSync(stagingDir).length === 0, fs.readdirSync(stagingDir).join(","));
      check("no fetch temp file left", tempFiles().length === 0, tempFiles().join(","));
      const presenterNow = listPresenterOutputs().filter((n) => !presenterOutputsBefore.has(n));
      check("exactly one presenter output was written (the portrait one)", presenterNow.length === 1, presenterNow.join(","));
      check("lane logs one line per finished import, ids + codes only", logs.some((l) => l.includes(img.id) && l.includes("ready")) && logs.some((l) => l.includes(landscapePres.id) && l.includes("not_portrait")));
      check("nothing printed mentions the media URLs", !captured.concat(logs).some((l) => l.includes("media.example")));
      logs.length = 0;
      for (const f of stocksFiles()) fs.rmSync(path.join(stocksDir, f), { force: true });
    });

    await section("C2) one user's slow import does not block another user's", async () => {
      await reset();
      const slow = gate();
      const base = Date.now() - 20 * MINUTE;
      const at = (s: number) => new Date(base + s * 1000);
      behaviors.set("https://slow.example/a1.mp4", { serve: serveVideo(landscape), gate: slow.promise });
      const a1 = await addImport("ua", "broll_video", { url: "https://slow.example/a1.mp4", createdAt: at(1) });
      const a2 = await addImport("ua", "broll_video", { bytes: landscape, createdAt: at(2) });
      const a3 = await addImport("ua", "broll_video", { bytes: landscape, createdAt: at(3) });
      const b1 = await addImport("ub", "broll_video", { bytes: landscape, createdAt: at(4) });
      behaviors.set("https://fast.example/c1.mp4", { serve: serveVideo(landscape) });
      const c1 = await addImport("uc", "broll_video", { url: "https://fast.example/c1.mp4", createdAt: at(5) });
      const l = newLane();
      let maxAInLane = 0;
      const sampler = setInterval(() => {
        void prisma.mediaImport.count({ where: { userId: "ua", status: "processing" } }).then((n) => { maxAInLane = Math.max(maxAInLane, n); });
      }, 15);
      l.start();
      const othersDone = await waitFor(async () => (await rowOf(b1.id)).status === "ready" && (await rowOf(c1.id)).status === "ready", 60_000);
      check("B's and C's imports finish while A's first import is still downloading", othersDone);
      check("…A1 is still in the lane", (await rowOf(a1.id)).status === "processing");
      check("…A's backlog waits (A holds at most one lane slot)", (await rowOf(a2.id)).status === "pending" && (await rowOf(a3.id)).status === "pending");
      slow.open();
      const aDone = await waitFor(async () => (await prisma.mediaImport.count({ where: { userId: "ua", status: "ready" } })) === 3, 60_000);
      clearInterval(sampler);
      await l.stop();
      check("A's three imports finish once its slow one does", aDone);
      check("A never held two lane slots at once", maxAInLane <= 1, `max=${maxAInLane}`);
      const aRows = await prisma.mediaImport.findMany({ where: { userId: "ua" }, orderBy: { claimedAt: "asc" } });
      check("A's imports ran oldest first", aRows.map((r) => r.id).join() === [a1.id, a2.id, a3.id].join());
      for (const f of stocksFiles()) fs.rmSync(path.join(stocksDir, f), { force: true });
    });

    await section("C3) deadline expiry: the watchdog fails the row; a late result is discarded and its files removed", async () => {
      await reset();
      const g = gate();
      behaviors.set("https://slow.example/late.png", { serve: servePng, gate: g.promise });
      const row = await addImport("ua", "broll_image", { url: "https://slow.example/late.png" });
      const l = newLane();
      l.start();
      check("claimed", await waitFor(async () => (await rowOf(row.id)).status === "processing"));
      const claimedRow = await rowOf(row.id);
      const call = fetchCalls.find((c) => c.url === "https://slow.example/late.png");
      const expectedRemaining = claimedRow.deadlineAt.getTime() - (call?.at ?? 0);
      check("fetch got the row's remaining time as its deadline (G23 10-min budget)", !!call && typeof call.deadlineMs === "number"
        && call.deadlineMs > 0 && call.deadlineMs <= imports.IMPORT_DEADLINE_MS && Math.abs(call.deadlineMs - expectedRemaining) < 2_000, JSON.stringify(call));
      check("fetch accepted only this purpose's kind and cap", JSON.stringify(call?.accept) === JSON.stringify({ image: MAX_BROLL_IMAGE_BYTES }));
      // Ten minutes pass.
      await prisma.mediaImport.update({ where: { id: row.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });
      const swept = await lane.runMediaImportWatchdog();
      const afterWatchdog = await rowOf(row.id);
      check("watchdog fails the expired processing row with fetch_timeout", swept.failed === 1 && afterWatchdog.status === "failed" && afterWatchdog.errorCode === "fetch_timeout", JSON.stringify(swept));
      g.open(); // the download completes after all
      check("the lane lets go of it", await waitFor(() => l.inFlight === 0));
      await l.stop();
      const final = await rowOf(row.id);
      check("…the row stays failed/fetch_timeout, no resultSrc", final.status === "failed" && final.errorCode === "fetch_timeout" && final.resultSrc === null);
      check("…no output, no staged file, no temp file", stocksFiles().length === 0 && !stagedExists(row.id) && tempFiles().length === 0, `${stocksFiles()} ${tempFiles()}`);

      // The pipeline finishes after the deadline, before the watchdog has run: the lane itself refuses
      // `ready`, fails the row and deletes the output it just produced.
      await reset();
      const g2 = gate();
      behaviors.set("https://slow.example/late2.png", { serve: servePng, gate: g2.promise });
      const row2 = await addImport("ua", "broll_image", { url: "https://slow.example/late2.png" });
      const l2 = newLane();
      l2.start();
      await waitFor(async () => (await rowOf(row2.id)).status === "processing");
      await prisma.mediaImport.update({ where: { id: row2.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });
      g2.open();
      check("lane finishes", await waitFor(() => l2.inFlight === 0 && fetchCalls.length > 0, 60_000));
      await l2.stop();
      const final2 = await rowOf(row2.id);
      check("finished past its deadline → failed/fetch_timeout, never ready", final2.status === "failed" && final2.errorCode === "fetch_timeout" && final2.resultSrc === null, JSON.stringify(final2));
      check("…the output it produced was deleted", stocksFiles().length === 0, stocksFiles().join(","));
      check("…no staged / temp file", !stagedExists(row2.id) && tempFiles().length === 0);

      // The deadline passes WHILE the real pipeline runs (e.g. queued behind a video job's B-roll
      // normalize — T9's semaphore is shared): the finished output is never published.
      await reset();
      const expiresMidway = await addImport("ua", "broll_video", { bytes: landscape });
      const failedMidway = await addImport("ub", "presenter", { bytes: portrait });
      const midwayOutputs: string[] = [];
      const l3 = newLane({
        processStaged: async (params: Parameters<typeof staging.processStagedUpload>[0]) => {
          const result = await staging.processStagedUpload(params);
          if (result.ok) {
            recordOutput(result.resultSrc);
            midwayOutputs.push(result.resultSrc);
            check(`${params.purpose}: the real pipeline produced its output`, result.resultSrc.startsWith("/api/renders/")
              ? fs.existsSync(path.join(rendersDir, path.basename(result.resultSrc)))
              : fs.existsSync(path.join(stocksDir, path.basename(result.resultSrc))));
          }
          await prisma.mediaImport.update({ where: { id: params.importId }, data: { deadlineAt: new Date(Date.now() - 1000) } });
          if (params.importId === failedMidway.id) await lane.runMediaImportWatchdog();
          return result;
        },
      });
      l3.start();
      check("both finish", await waitFor(async () => (await prisma.mediaImport.count({ where: { status: "failed" } })) === 2 && l3.inFlight === 0, 60_000));
      await l3.stop();
      const m1 = await rowOf(expiresMidway.id);
      const m2 = await rowOf(failedMidway.id);
      check("deadline passed during the pipeline → failed/fetch_timeout, never ready", m1.status === "failed" && m1.errorCode === "fetch_timeout" && m1.resultSrc === null, JSON.stringify(m1));
      check("watchdog failed it during the pipeline → stays failed/fetch_timeout", m2.status === "failed" && m2.errorCode === "fetch_timeout" && m2.resultSrc === null, JSON.stringify(m2));
      check("…the normalized B-roll clip and its marker were deleted", stocksFiles().length === 0, stocksFiles().join(","));
      const presenterMidway = midwayOutputs.filter((src) => src.startsWith("/api/renders/"));
      check("…the presenter output was deleted", presenterMidway.length === 1
        && !fs.existsSync(path.join(rendersDir, path.basename(presenterMidway[0]))), presenterMidway.join(","));
      check("…no staged / temp file", fs.readdirSync(stagingDir).length === 0 && tempFiles().length === 0);
    });

    await section("C4) a restart mid-processing is recovered by the watchdog, which also deletes the files", async () => {
      await reset();
      // The previous worker claimed two imports and died: a url import whose download had been
      // staged, and an upload. Plus the download of a third import cut off mid-body.
      const orphanUrl = await addImport("ua", "broll_video", { url: "https://dead.example/x.mp4" });
      const orphanUp = await addImport("ub", "broll_video", { bytes: landscape });
      behaviors.set("https://dead.example/x.mp4", { serve: serveVideo(landscape) });
      check("dead lane claimed both", (await lane.claimNextMediaImport())?.id === orphanUrl.id && (await lane.claimNextMediaImport())?.id === orphanUp.id);
      fs.writeFileSync(staging.stagedUploadPath(orphanUrl.id), landscape, { mode: 0o600 });
      const stalePart = path.join(tempDir, `media-import-${randomUUID()}.part`);
      const freshPart = path.join(tempDir, `media-import-${randomUUID()}.part`);
      fs.writeFileSync(stalePart, Buffer.alloc(1024), { mode: 0o600 });
      fs.writeFileSync(freshPart, Buffer.alloc(1024), { mode: 0o600 });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * MINUTE);
      fs.utimesSync(stalePart, twoHoursAgo, twoHoursAgo);

      // Restart: the worker sweeps at start, then runs a fresh lane.
      const swept = await lane.sweepMediaImportFiles();
      check("startup sweep removes the stale download (≥ 1 h old)", swept.tempRemoved === 1 && !fs.existsSync(stalePart), JSON.stringify(swept));
      check("…keeps a recent one (another lane may own it)", fs.existsSync(freshPart));
      check("…keeps staged files of live rows", stagedExists(orphanUrl.id) && stagedExists(orphanUp.id) && swept.stagedRemoved === 0);
      const l = newLane();
      l.start();
      await sleep(300);
      check("the new lane never re-claims the orphans", (await rowOf(orphanUrl.id)).status === "processing" && (await rowOf(orphanUp.id)).status === "processing"
        && fetchCalls.length === 0 && l.inFlight === 0);
      // Their ten minutes run out.
      await prisma.mediaImport.updateMany({ where: { id: { in: [orphanUrl.id, orphanUp.id] } }, data: { deadlineAt: new Date(Date.now() - 1000) } });
      const result = await lane.runMediaImportWatchdog();
      await l.stop();
      check("watchdog fails both orphans", result.failed === 2, JSON.stringify(result));
      const r1 = await rowOf(orphanUrl.id);
      const r2 = await rowOf(orphanUp.id);
      check("…with fetch_timeout", r1.status === "failed" && r1.errorCode === "fetch_timeout" && r2.status === "failed" && r2.errorCode === "fetch_timeout");
      check("…and deletes their staged files", !stagedExists(orphanUrl.id) && !stagedExists(orphanUp.id));
      check("a second pass changes nothing", (await lane.runMediaImportWatchdog()).failed === 0);
      fs.rmSync(freshPart, { force: true });
    });

    await section("C5) watchdog: codes per state, live rows untouched", async () => {
      await reset();
      const past = new Date(Date.now() - 1000);
      const pend = await addImport("ua", "broll_image", { bytes: png, deadlineAt: past });
      const streaming = await addImport("ub", "broll_video", { bytes: landscape, status: "processing", deadlineAt: past });
      const laneOrphan = await addImport("uc", "broll_video", { status: "processing", claimedAt: new Date(Date.now() - 11 * MINUTE), deadlineAt: past });
      const livePend = await addImport("ud", "broll_image", { bytes: png });
      const liveStreaming = await addImport("ua", "broll_video", { bytes: landscape, status: "processing" });
      const done = await addImport("ub", "broll_image", { status: "ready", deadlineAt: past });
      const dead = await addImport("uc", "broll_image", { status: "failed", deadlineAt: past });
      await prisma.mediaImport.update({ where: { id: done.id }, data: { resultSrc: "/api/stocks/broll-upload-1-x.mp4" } });
      await prisma.mediaImport.update({ where: { id: dead.id }, data: { errorCode: "not_portrait" } });
      const result = await lane.runMediaImportWatchdog();
      check("three expired active rows failed", result.failed === 3, JSON.stringify(result));
      check("expired pending (never claimed) → fetch_timeout, staged file deleted", (await rowOf(pend.id)).errorCode === "fetch_timeout" && !stagedExists(pend.id));
      check("expired upload still streaming (web died mid-PUT) → upload_incomplete, staged file deleted", (await rowOf(streaming.id)).errorCode === "upload_incomplete" && !stagedExists(streaming.id));
      check("expired lane-claimed row → fetch_timeout", (await rowOf(laneOrphan.id)).errorCode === "fetch_timeout");
      check("live rows untouched, their staged files kept", (await rowOf(livePend.id)).status === "pending" && (await rowOf(liveStreaming.id)).status === "processing"
        && stagedExists(livePend.id) && stagedExists(liveStreaming.id));
      const doneAfter = await rowOf(done.id);
      const deadAfter = await rowOf(dead.id);
      check("ready / failed rows untouched", doneAfter.status === "ready" && doneAfter.resultSrc === "/api/stocks/broll-upload-1-x.mp4" && deadAfter.errorCode === "not_portrait");
    });

    await section("C6) startup sweeps: fetch temp (age) + staging dir (rows that are no longer live)", async () => {
      await reset();
      const live = await addImport("ua", "broll_image", { bytes: png });
      const streaming = await addImport("ub", "broll_video", { bytes: landscape, status: "processing" });
      const readyRow = await addImport("uc", "broll_image", { bytes: png, status: "ready" });
      const failedRow = await addImport("ud", "broll_image", { bytes: png, status: "failed" });
      const ghost = path.join(stagingDir, `${randomUUID()}.upload`); // no row at all
      fs.writeFileSync(ghost, png, { mode: 0o600 });
      const foreign = path.join(stagingDir, "notes.txt");
      fs.writeFileSync(foreign, "keep");
      const dirLike = path.join(stagingDir, "dir.upload");
      fs.mkdirSync(dirLike);
      const outside = path.join(tmp, "outside.bin");
      fs.writeFileSync(outside, "target");
      const linkLike = path.join(stagingDir, "link.upload");
      fs.symlinkSync(outside, linkLike);
      const swept = await lane.sweepMediaImportFiles();
      check("removes staged files whose row is ready / failed / missing (3)", swept.stagedRemoved === 3 && !stagedExists(readyRow.id) && !stagedExists(failedRow.id) && !fs.existsSync(ghost), JSON.stringify(swept));
      check("keeps staged files of pending and still-streaming rows", stagedExists(live.id) && stagedExists(streaming.id));
      check("leaves foreign names, directories and symlinks (never follows one)", fs.existsSync(foreign) && fs.statSync(dirLike).isDirectory()
        && fs.lstatSync(linkLike).isSymbolicLink() && fs.readFileSync(outside, "utf8") === "target");
      fs.rmSync(linkLike);
      fs.rmSync(dirLike, { recursive: true });
      fs.rmSync(foreign);

      // A planted symlink in place of either directory is never swept through.
      const decoyDir = path.join(tmp, "decoy");
      fs.mkdirSync(decoyDir, { recursive: true });
      const decoyStaged = path.join(decoyDir, `${randomUUID()}.upload`);
      const decoyTemp = path.join(decoyDir, `media-import-${randomUUID()}.part`);
      fs.writeFileSync(decoyStaged, "x");
      fs.writeFileSync(decoyTemp, "x");
      const old = new Date(Date.now() - 3 * 60 * MINUTE);
      fs.utimesSync(decoyTemp, old, old);
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.symlinkSync(decoyDir, stagingDir);
      fs.symlinkSync(decoyDir, tempDir);
      const viaLinks = await lane.sweepMediaImportFiles();
      check("symlinked staging / temp dirs are not swept", viaLinks.stagedRemoved === 0 && viaLinks.tempRemoved === 0 && fs.existsSync(decoyStaged) && fs.existsSync(decoyTemp), JSON.stringify(viaLinks));
      fs.rmSync(stagingDir);
      fs.rmSync(tempDir);
      ensurePrivateDir(stagingDir);
      ensurePrivateDir(tempDir);
      const missing = await lane.sweepMediaImportFiles();
      check("empty dirs → nothing to do", missing.stagedRemoved === 0 && missing.tempRemoved === 0);
    });

    await section("C7) old upload-link rows are pruned (T11 contract: rows never deleted otherwise)", async () => {
      await reset();
      const mk = (issuedAt: Date) => prisma.mcpUploadToken.create({
        data: { tokenHash: randomUUID(), userId: "ua", kind: "image", issuedAt, importId: randomUUID() },
      });
      const oldRow = await mk(new Date(Date.now() - 25 * 60 * MINUTE));
      const recent = await mk(new Date(Date.now() - 60 * MINUTE));
      const pruned = await lane.pruneUploadTokens();
      check("tokens issued > 1 day ago deleted, recent kept", pruned === 1
        && !(await prisma.mcpUploadToken.findUnique({ where: { id: oldRow.id } })) && !!(await prisma.mcpUploadToken.findUnique({ where: { id: recent.id } })));
    });

    await section("C8) no raw error, IP, path or URL reaches a row or a log", async () => {
      await reset();
      const stopCapture = captureConsole();
      const leakyUrl = "https://secret-host.example/media.mp4?X-Amz-Signature=deadbeef";
      behaviors.set(leakyUrl, { error: new Error("connect ECONNREFUSED 10.9.8.7:443 while writing /etc/passwd") });
      const leaky = await addImport("ua", "broll_video", { url: leakyUrl });
      class OddError extends Error { code = "SOMETHING_ELSE /var/www/ai-content"; }
      behaviors.set("https://odd.example/x.mp4", { error: new OddError("odd") });
      const odd = await addImport("ub", "broll_video", { url: "https://odd.example/x.mp4" });
      const l = newLane();
      l.start();
      await waitFor(async () => (await prisma.mediaImport.count({ where: { status: "failed" } })) === 2);
      await l.stop();
      const captured = stopCapture();
      const leakyRow = await rowOf(leaky.id);
      check("a raw (non-MediaFetchError) throw → fetch_failed", leakyRow.status === "failed" && leakyRow.errorCode === "fetch_failed", JSON.stringify(leakyRow));
      check("an unknown error code is never copied into the row", (await rowOf(odd.id)).errorCode === "fetch_failed");
      const text = captured.concat(logs).join("\n");
      check("logs carry no IP, path, upstream text or URL", !/10\.9\.8\.7|\/etc\/passwd|ECONNREFUSED|secret-host|X-Amz|\/var\/www/.test(text), text);
      logs.length = 0;
    });

    await section("C9) the default fetch is the production G23 guard (no network needed for these)", async () => {
      await reset();
      const cases: Array<[string, string]> = [
        ["http://media.example/a.png", "url_not_https"],
        ["https://127.0.0.1/a.png", "url_not_public"],
        ["https://[::1]/a.png", "url_not_public"],
        ["https://media.example:8443/a.png", "url_not_public"],
      ];
      const rows = [];
      for (const [url] of cases) rows.push(await addImport(`claim-${rows.length}`, "broll_image", { url }));
      const l = lane.createMediaImportLane({ pollMs: 20, watchdogMs: 60 * MINUTE, stocksDir, log: logger });
      l.start();
      await waitFor(async () => (await prisma.mediaImport.count({ where: { status: "failed" } })) === cases.length, 20_000);
      await l.stop();
      for (let i = 0; i < cases.length; i += 1) {
        const r = await rowOf(rows[i].id);
        check(`${cases[i][0]} → ${cases[i][1]}`, r.status === "failed" && r.errorCode === cases[i][1], `${r.status}/${r.errorCode}`);
      }
      check("nothing left in the temp dir", tempFiles().length === 0);
      logs.length = 0;
    });

    await section("C10) each purpose fetches only its kind(s), with the web upload's cap (G22)", async () => {
      await reset();
      // A url B-roll import (replace_broll_window, T13) is queued as broll_video and may be an
      // image or a video — the bytes decide (C11), each kind with its own web cap.
      const expectations: Array<["broll_image" | "broll_video" | "presenter", Record<string, number>]> = [
        ["broll_image", { image: MAX_BROLL_IMAGE_BYTES }],
        ["broll_video", { image: MAX_BROLL_IMAGE_BYTES, video: MAX_BROLL_VIDEO_BYTES }],
        ["presenter", { video: imports.MAX_PRESENTER_IMPORT_BYTES }],
      ];
      for (const [purpose] of expectations) behaviors.set(`https://cap.example/${purpose}`, { error: new fetchMod.MediaFetchError("file_too_large") });
      let i = 0;
      for (const [purpose] of expectations) await addImport(`claim-${i++}`, purpose, { url: `https://cap.example/${purpose}` });
      const l = newLane();
      l.start();
      await waitFor(async () => (await prisma.mediaImport.count({ where: { status: "failed" } })) === 3);
      await l.stop();
      for (const [purpose, accept] of expectations) {
        const call = fetchCalls.find((c) => c.url === `https://cap.example/${purpose}`);
        check(`${purpose} → accept ${JSON.stringify(accept)}`, JSON.stringify(call?.accept) === JSON.stringify(accept), JSON.stringify(call?.accept));
      }
      check("file_too_large passes through", (await prisma.mediaImport.count({ where: { errorCode: "file_too_large" } })) === 3);
      logs.length = 0;
    });

    await section("C11) a url B-roll import (broll_video) that serves an image is processed and recorded as broll_image", async () => {
      await reset();
      behaviors.set("https://media.example/window.png", { serve: servePng });
      const row = await addImport("uc", "broll_video", { url: "https://media.example/window.png" });
      const l = newLane();
      l.start();
      await waitFor(async () => (await rowOf(row.id)).status === "ready", 60_000);
      await l.stop();
      const r = await rowOf(row.id);
      check("ready with a Ken Burns mp4 under /api/stocks/broll-upload-*", r.status === "ready" && /^\/api\/stocks\/broll-upload-[\w.-]+\.mp4$/.test(r.resultSrc ?? ""), `${r.status} ${r.resultSrc}`);
      check("purpose recorded as broll_image (what the bytes were)", r.purpose === "broll_image", r.purpose);
      check("the agent's url is cleared", r.sourceUrl === null);
      check("nothing left in the temp or staging dir", tempFiles().length === 0 && !stagedExists(row.id));
      for (const f of stocksFiles()) fs.rmSync(path.join(stocksDir, f), { force: true });
      logs.length = 0;
    });

    // ── D. video-job slots are unaffected ──────────────────────────────────────────────────
    await section("D1) both lane slots busy: start() returns at once and a queued VideoJob is still claimed", async () => {
      await reset();
      const ga = gate();
      const gb = gate();
      behaviors.set("https://slow.example/da.png", { serve: servePng, gate: ga.promise });
      behaviors.set("https://slow.example/db.png", { serve: servePng, gate: gb.promise });
      await addImport("ua", "broll_image", { url: "https://slow.example/da.png" });
      await addImport("ub", "broll_image", { url: "https://slow.example/db.png" });
      const l = newLane();
      const t0 = Date.now();
      l.start();
      const startMs = Date.now() - t0;
      check("start() does not block its caller", startMs < 50, `${startMs} ms`);
      check("both lane slots busy", await waitFor(() => l.inFlight === 2));
      const untouched = await prisma.videoJob.create({ data: { userId: "uc", status: "done", inputJson: "{}" } });
      const queued = await prisma.videoJob.create({ data: { userId: "uc", status: "queued", inputJson: "{}" } });
      const t1 = Date.now();
      const claimed = await claimNextRunnableJob();
      check("a queued VideoJob is claimed while the lane is full", claimed?.id === queued.id && claimed?.status === "processing" && Date.now() - t1 < 2_000);
      const untouchedAfter = await prisma.videoJob.findUniqueOrThrow({ where: { id: untouched.id } });
      check("the lane never touches VideoJob rows", untouchedAfter.updatedAt.getTime() === untouched.updatedAt.getTime() && untouchedAfter.status === "done");
      check("lane still holds exactly its own 2 slots", l.inFlight === 2);
      ga.open();
      gb.open();
      await waitFor(() => l.inFlight === 0, 60_000);
      await l.stop();
      for (const f of stocksFiles()) fs.rmSync(path.join(stocksDir, f), { force: true });
      logs.length = 0;
    });

    await section("D2) mcp-video-worker: the video loop is untouched, the lane runs beside it", async () => {
      const src = fs.readFileSync(path.join(ROOT, "scripts/mcp-video-worker.ts"), "utf8");
      const needles = [
        "const raw = Number(process.env.MCP_WORKER_CONCURRENCY ?? 2);",
        "return Math.min(4, Math.max(1, Math.floor(raw)));",
        "while (running && active.size < CONCURRENCY) {",
        "const job = await claimNextRunnableJob();",
        "const p: Promise<void> = runJob(job);",
        "if (active.size >= CONCURRENCY) {",
        "await Promise.race(active).catch(() => {}); // all slots busy — wait for one to free",
        "await Promise.allSettled(active);",
      ];
      for (const needle of needles) check(`video loop unchanged: ${needle.slice(0, 60)}`, src.includes(needle));
      check("`active` holds video jobs only (one add)", (src.match(/active\.add\(/g) ?? []).length === 1);
      check("worker sweeps import files at start, before the lane starts", /await sweepMediaImportFiles\(\)[\s\S]*importLane\.start\(\)/.test(src));
      check("worker creates the lane with no test seam (fetchMedia / processStaged / stocksDir)", /createMediaImportLane\(/.test(src) && !/fetchMedia|processStaged|stocksDir/.test(src));
      check("signals stop the lane too", (src.match(/importLane\.stop\(\)/g) ?? []).length >= 3);
      const laneSrc = fs.readFileSync(path.join(ROOT, "src/lib/media-import/lane.ts"), "utf8");
      check("the lane reads no env var (nothing to add to ecosystem.config.js)", !laneSrc.includes("process.env"));
      check("the lane never touches VideoJob", !/videoJob/.test(laneSrc));
    });

    await section("D3) the real worker process: startup sweep, watchdog, a real import, clean shutdown", async () => {
      await reset();
      const imp = await addImport("ua", "broll_video", { bytes: landscape });
      const orphan = await addImport("ub", "broll_video", { bytes: landscape, status: "processing", claimedAt: new Date(Date.now() - 20 * MINUTE), deadlineAt: new Date(Date.now() - 10 * MINUTE) });
      const finished = await addImport("uc", "broll_image", { bytes: png, status: "failed" });
      const stalePart = path.join(tempDir, `media-import-${randomUUID()}.part`);
      fs.writeFileSync(stalePart, Buffer.alloc(16), { mode: 0o600 });
      const old = new Date(Date.now() - 2 * 60 * MINUTE);
      fs.utimesSync(stalePart, old, old);

      const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/mcp-video-worker.ts"], {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MCP_SERVICE_SECRET: "lane-test-secret-0123456789abcdef0123456789",
          MCP_WORKER_POLL_MS: "200",
          MCP_INTERNAL_BASE_URL: "http://127.0.0.1:9",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      child.stderr.on("data", (chunk) => { out += String(chunk); });
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      try {
        const ready = await waitFor(async () => (await rowOf(imp.id)).status === "ready", 90_000, 100);
        check("worker's lane processes a staged upload to ready", ready, out.slice(-3000));
        const r = await rowOf(imp.id);
        if (r.resultSrc) {
          const produced = path.join(repoStocksDir, path.basename(r.resultSrc));
          check("…output in <cwd>/stocks", fs.existsSync(produced));
          fs.rmSync(produced, { force: true });
          fs.rmSync(`${produced}.normalized`, { force: true });
        }
        const o = await rowOf(orphan.id);
        check("worker's watchdog failed the orphan left by a previous run, and deleted its file", o.status === "failed" && o.errorCode === "fetch_timeout" && !stagedExists(orphan.id));
        check("startup sweep removed the stale download and the finished row's staged file", !fs.existsSync(stalePart) && !stagedExists(finished.id));
        check("video loop started as before (concurrency=2)", out.includes("[mcp-worker] started (concurrency=2)"), out.slice(-2000));
      } finally {
        child.kill("SIGTERM");
      }
      const code = await Promise.race([exited, sleep(20_000).then(() => "timeout" as const)]);
      check("SIGTERM: worker drains the lane and exits 0", code === 0 && out.includes("[mcp-worker] stopped"), `exit=${String(code)}\n${out.slice(-2000)}`);
      if (code === "timeout") child.kill("SIGKILL");
      check("worker printed no media path or raw error for the import", !out.includes(stagingDir) && !out.includes(tempDir));
    });

    // ── E. wiring ──────────────────────────────────────────────────────────────────────────
    await section("E) wiring: package.json + CI (the ffmpeg step)", async () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
      check("package.json exposes verify:media-import-lane", /scripts\/verify-media-import-lane\.ts/.test(pkg.scripts["verify:media-import-lane"] ?? ""));
      const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
      const install = ci.indexOf("sudo apt-get install -y --no-install-recommends ffmpeg");
      const run = ci.indexOf("npm run verify:media-import-lane");
      check("ci.yml runs it after ffmpeg is installed (G24 step)", install > 0 && run > install, `install=${install} run=${run}`);
    });

    const codes = await prisma.mediaImport.findMany({ where: { errorCode: { not: null } }, select: { errorCode: true } });
    check("every errorCode the lane wrote is from its fixed vocabulary", codes.every((c) => allCodes.has(String(c.errorCode))), codes.map((c) => c.errorCode).join(","));
  } finally {
    for (const file of rendersOutputs) fs.rmSync(file, { force: true });
    for (const name of listPresenterOutputs()) if (!presenterOutputsBefore.has(name)) fs.rmSync(path.join(rendersDir, name), { force: true });
    for (const name of listRepoStocks()) {
      if (!repoStocksBefore.has(name)) {
        fs.rmSync(path.join(repoStocksDir, name), { force: true });
      }
    }
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (process.argv[2] === CLAIM_CHILD_FLAG) {
  runClaimChild().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
