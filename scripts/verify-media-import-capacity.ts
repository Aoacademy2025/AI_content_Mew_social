// Media Import capacity guards before MCP_EDITOR_PROJECT_PUBLIC (plan
// docs/plans/2026-10-03-mcp-edit-before-export.md follow-ups 1, 2, 4; EP5 backlog #16; ADR 0065):
//
//   A. limits: documented defaults; every env override honoured in a fresh process; a missing,
//      malformed or below-floor value falls back to the default (fail closed).
//   B. burst (#16): 25 upload links issued back to back; PUTs with nothing processed yet are
//      admitted up to MAX_ACTIVE_IMPORTS (12), the next is refused with retryAfterSeconds and its
//      link kept, and once the lane drains the same links finish the batch (sequential and
//      concurrent).
//   C. per-user byte budget over a rolling hour and a rolling 24 h, at create_upload_url, at the
//      PUT (the declared Content-Length is what counts, not the kind's cap; link kept on refusal)
//      and at url admission; retryAfterSeconds = when enough counted bytes age out; ready/live
//      rows count, failed and expired rows do not, an unknown size counts as the purpose's cap.
//   D. staging fair share: one user's live imports may hold at most their share of the global
//      budget, so nine greedy accounts cannot lock a tenth out; the global budget counts real
//      bytes; the share holds across two processes on one SQLite file.
//   E. the PUT's free-disk floor counts bytes still in flight (follow-up 2), fail closed.
//   F. a queued import waits up to the queue deadline (30 min); the lane claims fairly across
//      users even when every user has a deep queue; the lane records a url import's real size.
//   G. wiring: package.json, CI, schema column.
//
// No ffmpeg needed: uploads are PNG-signed buffers (the PUT sniffs magic bytes) and the lane runs
// with injected fetch/process seams.
// Run: node --conditions=react-server --import tsx scripts/verify-media-import-capacity.ts
import { execFileSync, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const CHILD_FLAG = "--capacity-child";
const LIMITS_CHILD_FLAG = "--limits-child";
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A buffer the PUT sniffs as PNG (magic bytes only — the lane is not run on these). */
const pngOf = (size: number) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(Math.max(0, size - PNG_SIGNATURE.length))]);
/** An ISO-BMFF ("ftyp") buffer the PUT sniffs as a video container. */
const mp4Of = (size: number) => {
  const head = Buffer.from([0, 0, 0, 0x18, ...Buffer.from("ftypisom")]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
};
const near = (got: unknown, expected: number, tolerance = 2) => typeof got === "number" && Math.abs(got - expected) <= tolerance;

// ── child modes ────────────────────────────────────────────────────────────────────────────

/** Print the limits as this process sees them (fresh import, env set by the parent). */
async function runLimitsChild(): Promise<void> {
  const limits = await import("../src/lib/media-import/limits");
  process.stdout.write(`LIMITS ${JSON.stringify({
    active: limits.MAX_ACTIVE_IMPORTS,
    share: limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER,
    hour: limits.MAX_IMPORT_BYTES_PER_HOUR,
    day: limits.MAX_IMPORT_BYTES_PER_DAY,
    staging: limits.MAX_STAGED_IMPORT_BYTES,
    queue: limits.IMPORT_QUEUE_DEADLINE_MS,
  })}\n`);
}

type ChildSpec = { userId: string; attempts: number; goFile: string };

/** One "process" racing url admissions for one user (presenter = 500 MB reservation each). */
async function runChild(): Promise<void> {
  const spec = JSON.parse(process.argv[3] ?? "{}") as ChildSpec;
  const lib = await import("../src/lib/media-import/imports");
  const { prisma } = await import("../src/lib/prisma");
  await prisma.$queryRawUnsafe("SELECT 1");
  fs.writeFileSync(`${spec.goFile}.ready-${process.pid}`, "ready");
  while (!fs.existsSync(spec.goFile)) await new Promise((resolve) => setTimeout(resolve, 2));
  const out = await Promise.all(Array.from({ length: spec.attempts }, (_, i) =>
    lib.createUrlImport(spec.userId, `https://media.example.test/race-${process.pid}-${i}.mp4`, new Date(), "presenter")));
  process.stdout.write(`RESULT ${JSON.stringify(out.map((r) => (r.ok ? { ok: true } : { ok: false, code: r.code })))}\n`);
  await prisma.$disconnect();
}

function runChildren(specs: ChildSpec[], goFile: string): Promise<Array<Array<{ ok: boolean; code?: string }>>> {
  const children = specs.map((spec) => new Promise<Array<{ ok: boolean; code?: string }>>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", __filename, CHILD_FLAG, JSON.stringify(spec)],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("exit", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (code !== 0 || !line) return reject(new Error(`child exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line.slice("RESULT ".length)));
    });
  }));
  const dir = path.dirname(goFile);
  const readyPrefix = `${path.basename(goFile)}.ready-`;
  const barrier = setInterval(() => {
    if (fs.readdirSync(dir).filter((name) => name.startsWith(readyPrefix)).length >= specs.length) {
      clearInterval(barrier);
      fs.writeFileSync(goFile, "go");
    }
  }, 5);
  return Promise.all(children).finally(() => clearInterval(barrier));
}

// ── parent ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-import-capacity-"));
  process.env.MEDIA_IMPORT_STAGING_DIR = path.join(tmp, "staging");
  const dbPath = path.join(tmp, "media-import-capacity.db");
  process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1`;
  for (const key of [
    "MCP_EDITOR_PROJECT_PUBLIC", "INTERNAL_AI_ALLOWED_EMAILS", "INTERNAL_AI_ALLOWED_DOMAINS",
    "MEDIA_IMPORT_MAX_ACTIVE_PER_USER", "MEDIA_IMPORT_USER_STAGING_SHARE_BYTES", "MEDIA_IMPORT_USER_BYTES_PER_HOUR",
    "MEDIA_IMPORT_USER_BYTES_PER_DAY", "MEDIA_IMPORT_STAGING_BUDGET_BYTES", "MEDIA_IMPORT_QUEUE_DEADLINE_MS",
  ]) {
    delete process.env[key];
  }
  process.env.MCP_PUBLIC_ORIGIN = "https://studio.test";
  execSync("npx prisma db push --skip-generate", { cwd: ROOT, stdio: "ignore", env: process.env });

  const limits = await import("../src/lib/media-import/limits");
  const lib = await import("../src/lib/media-import/imports");
  const staging = await import("../src/lib/media-import/upload-staging");
  const laneMod = await import("../src/lib/media-import/lane");
  const tools = await import("../src/lib/mcp/media-import-tools");
  const copy = await import("../src/lib/mcp/media-import-copy");
  const route = await import("../src/app/api/mcp-uploads/[token]/route");
  const { prisma } = await import("../src/lib/prisma");
  const { checkFailureEnvelope } = await import("./mcp-agent-neutral-checks");

  const now = new Date();
  async function makeUser(id: string) {
    await prisma.user.create({
      data: {
        id, name: id, email: `qa-cap-${id}@aoacademy.co`, plan: "PRO",
        minutesLimit: 80, minutesUsed: 0, usagePeriodStartedAt: now, trialEndsAt: null, usageLimit: 100, usageCount: 0,
        subStatus: "active", stripeSubscriptionId: `sub_${id}`, planExpiresAt: new Date(now.getTime() + 30 * 24 * HOUR),
      },
    });
    await prisma.payment.create({
      data: { userId: id, stripeSessionId: `cs_${id}`, plan: "PRO", amount: 59_900, status: "PAID", periodDays: 30, paidAt: now },
    });
    return prisma.user.findUniqueOrThrow({ where: { id } });
  }

  type PutResult = { status: number; body: Record<string, unknown> };
  async function put(token: string, body: Buffer, declared: number | null = body.length): Promise<PutResult> {
    const request = new Request(`https://studio.test/api/mcp-uploads/${encodeURIComponent(token)}`, {
      method: "PUT",
      body,
      headers: declared === null ? {} : { "content-length": String(declared) },
      // @ts-expect-error -- Node's fetch Request needs duplex for a streamed body
      duplex: "half",
    });
    const response = await route.PUT(request, { params: Promise.resolve({ token }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function reset() {
    await prisma.mediaImport.deleteMany({});
    await prisma.mcpUploadToken.deleteMany({});
    const dir = staging.mediaImportStagingDir();
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
  }
  async function issue(userId: string, kind: "image" | "video" | "presenter") {
    const issued = await lib.issueUploadToken(userId, kind);
    if (!issued.ok) throw new Error(`fixture: issue refused ${issued.code}`);
    return issued;
  }
  type Fixture = { userId: string; purpose?: string; status?: string; bytes?: number | null; createdAt?: Date; deadlineAt?: Date; source?: string; claimedAt?: Date | null };
  async function rows(list: Fixture[]) {
    await prisma.mediaImport.createMany({
      data: list.map((r) => ({
        userId: r.userId,
        purpose: r.purpose ?? "broll_video",
        source: r.source ?? "upload",
        status: r.status ?? "ready",
        bytes: r.bytes === undefined ? null : r.bytes,
        createdAt: r.createdAt ?? new Date(),
        deadlineAt: r.deadlineAt ?? new Date(Date.now() + 10 * MINUTE),
        claimedAt: r.claimedAt ?? null,
      })),
    });
  }
  const ago = (ms: number) => new Date(Date.now() - ms);
  const linkUnused = async (importId: string) => (await prisma.mcpUploadToken.findUnique({ where: { importId } }))?.usedAt === null;

  const owner = await makeUser("owner");
  const other = await makeUser("other");

  try {
    // ── A. limits ──────────────────────────────────────────────────────────────────────────
    await section("A1) documented defaults", async () => {
      check("MAX_ACTIVE_IMPORTS = 12 (was 3; EP5 #16 burst)", limits.MAX_ACTIVE_IMPORTS === 12 && lib.MAX_ACTIVE_IMPORTS === 12, String(lib.MAX_ACTIVE_IMPORTS));
      check("per-user staging share = 1.5 GiB (three 500 MB presenter clips)", limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER === 1536 * MIB
        && limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER >= 3 * lib.MAX_PRESENTER_IMPORT_BYTES);
      check("per-user bytes per rolling hour = 2 GiB", limits.MAX_IMPORT_BYTES_PER_HOUR === 2 * GIB);
      check("per-user bytes per rolling 24 h = 3 GiB", limits.MAX_IMPORT_BYTES_PER_DAY === 3 * GIB);
      check("global staging budget = 15 GiB", limits.MAX_STAGED_IMPORT_BYTES === 15 * GIB && lib.MAX_STAGED_IMPORT_BYTES === 15 * GIB);
      check("queue deadline = 30 min; processing budget stays 10 min", limits.IMPORT_QUEUE_DEADLINE_MS === 30 * MINUTE && lib.IMPORT_DEADLINE_MS === 10 * MINUTE);
      check("HERO-69 hourly count caps unchanged (60 imports, 60 links)", lib.MAX_IMPORTS_PER_HOUR === 60 && lib.MAX_UPLOAD_LINKS_PER_HOUR === 60);
      check("a burst fits inside the hourly caps", lib.MAX_ACTIVE_IMPORTS <= lib.MAX_IMPORTS_PER_HOUR && lib.MAX_ACTIVE_IMPORTS <= lib.MAX_UPLOAD_LINKS_PER_HOUR);
      check("every byte budget holds the largest single file (500 MB presenter)",
        [limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER, limits.MAX_IMPORT_BYTES_PER_HOUR, limits.MAX_IMPORT_BYTES_PER_DAY, limits.MAX_STAGED_IMPORT_BYTES]
          .every((b) => b >= lib.MAX_PRESENTER_IMPORT_BYTES));
      check("share ≤ hourly ≤ daily, and ten full shares fit the global budget",
        limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER <= limits.MAX_IMPORT_BYTES_PER_HOUR && limits.MAX_IMPORT_BYTES_PER_HOUR <= limits.MAX_IMPORT_BYTES_PER_DAY
          && limits.MAX_STAGED_IMPORT_BYTES / limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER >= 10);
      check("labels", limits.formatImportBytes(2 * GIB) === "2 GB" && limits.formatImportBytes(1.5 * GIB) === "1.5 GB" && limits.formatImportBytes(500 * MIB) === "500 MB");
    });

    await section("A2) env overrides in a fresh process; malformed / below-floor values fall back (fail closed)", async () => {
      const read = (env: Record<string, string>) => {
        const out = execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", __filename, LIMITS_CHILD_FLAG], {
          cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8",
        });
        return JSON.parse(out.split("\n").find((l) => l.startsWith("LIMITS "))!.slice("LIMITS ".length)) as Record<string, number>;
      };
      const set = read({
        MEDIA_IMPORT_MAX_ACTIVE_PER_USER: "40",
        MEDIA_IMPORT_USER_STAGING_SHARE_BYTES: String(2 * GIB),
        MEDIA_IMPORT_USER_BYTES_PER_HOUR: String(3 * GIB),
        MEDIA_IMPORT_USER_BYTES_PER_DAY: String(8 * GIB),
        MEDIA_IMPORT_STAGING_BUDGET_BYTES: String(20 * GIB),
        MEDIA_IMPORT_QUEUE_DEADLINE_MS: String(45 * MINUTE),
      });
      check("valid overrides are honoured", set.active === 40 && set.share === 2 * GIB && set.hour === 3 * GIB && set.day === 8 * GIB
        && set.staging === 20 * GIB && set.queue === 45 * MINUTE, JSON.stringify(set));
      const bad = read({
        MEDIA_IMPORT_MAX_ACTIVE_PER_USER: "0",
        MEDIA_IMPORT_USER_STAGING_SHARE_BYTES: "1GB",
        MEDIA_IMPORT_USER_BYTES_PER_HOUR: "-5",
        MEDIA_IMPORT_USER_BYTES_PER_DAY: String(100 * MIB),
        MEDIA_IMPORT_STAGING_BUDGET_BYTES: "1e12",
        MEDIA_IMPORT_QUEUE_DEADLINE_MS: String(MINUTE),
      });
      check("0 / unit suffix / negative / below the 500 MB floor / exponent / below 10 min → defaults",
        bad.active === 12 && bad.share === 1536 * MIB && bad.hour === 2 * GIB && bad.day === 3 * GIB && bad.staging === 15 * GIB && bad.queue === 30 * MINUTE,
        JSON.stringify(bad));
      const capped = read({ MEDIA_IMPORT_USER_STAGING_SHARE_BYTES: String(4 * GIB), MEDIA_IMPORT_STAGING_BUDGET_BYTES: String(3 * GIB) });
      check("a share above the global budget is clamped to the budget", capped.share === 3 * GIB && capped.staging === 3 * GIB, JSON.stringify(capped));
    });

    // ── B. burst ───────────────────────────────────────────────────────────────────────────
    await section("B1) burst (#16): 25 links, then sequential PUTs — MAX admitted, the next waits retryAfterSeconds, the same links finish the batch", async () => {
      await reset();
      const MAX = lib.MAX_ACTIVE_IMPORTS;
      const links = [];
      for (let i = 0; i < 25; i += 1) links.push(await lib.issueUploadToken(owner.id, i % 2 ? "video" : "image"));
      check("25 links issued back to back (an unused link is not an active import)", links.every((l) => l.ok), JSON.stringify(links.filter((l) => !l.ok)));
      const body = (link: { kind: string }) => link.kind === "image" ? pngOf(64 * 1024) : mp4Of(64 * 1024);
      const statuses: number[] = [];
      for (const link of links.slice(0, MAX)) if (link.ok) statuses.push((await put(link.token, body(link))).status);
      check(`${MAX} PUTs in a row → ${MAX} × 202 (the old 3-active cap refused the 4th)`, statuses.length === MAX && statuses.every((s) => s === 202), JSON.stringify(statuses));
      check(`${MAX} imports pending for the lane`, (await prisma.mediaImport.count({ where: { userId: owner.id, status: "pending" } })) === MAX);
      const next = links[MAX];
      const refusedPut = next.ok ? await put(next.token, body(next)) : null;
      check(`PUT #${MAX + 1} → 429 too_many_active_imports with retryAfterSeconds (wait for the lane, not a blind 8 s)`,
        refusedPut?.status === 429 && refusedPut.body.code === "too_many_active_imports" && refusedPut.body.retryAfterSeconds === limits.ACTIVE_IMPORT_RETRY_SECONDS
          && checkFailureEnvelope(refusedPut.body).length === 0, JSON.stringify(refusedPut));
      check("…its link is kept", next.ok && (await linkUnused(next.importId)));
      // The lane finishes the queued burst (a B-roll image takes seconds); the agent re-PUTs on the same links.
      await prisma.mediaImport.updateMany({ where: { userId: owner.id, status: "pending" }, data: { status: "ready" } });
      const rest: number[] = [];
      for (const link of links.slice(MAX, 2 * MAX)) if (link.ok) rest.push((await put(link.token, body(link))).status);
      await prisma.mediaImport.updateMany({ where: { userId: owner.id, status: "pending" }, data: { status: "ready" } });
      for (const link of links.slice(2 * MAX)) if (link.ok) rest.push((await put(link.token, body(link))).status);
      check("after the lane drains, the same links finish the batch → all 25 imported inside the hourly caps",
        rest.length === 25 - MAX && rest.every((s) => s === 202)
          && (await prisma.mediaImport.count({ where: { userId: owner.id, status: { in: ["pending", "ready"] } } })) === 25, JSON.stringify(rest));
      await prisma.mediaImport.updateMany({ where: { userId: owner.id, status: "ready" }, data: { status: "pending" } });
      const more = await lib.issueUploadToken(owner.id, "image");
      check("with MAX or more imports live, create_upload_url is refused too_many_active_imports", !more.ok && more.code === "too_many_active_imports", JSON.stringify(more));
      check("…with retryAfterSeconds (wait for the lane, not a blind 8 s)", !more.ok && more.retryAfterSeconds === limits.ACTIVE_IMPORT_RETRY_SECONDS, JSON.stringify(more));
      const envelope = await tools.createUploadUrlTool(owner.id, { kind: "image" }) as Record<string, unknown>;
      check("tool envelope: G14 + top-level retryAfterSeconds + the cap in the message",
        checkFailureEnvelope(envelope).length === 0 && envelope.code === "too_many_active_imports" && envelope.retryAfterSeconds === limits.ACTIVE_IMPORT_RETRY_SECONDS
          && String(envelope.message).includes(String(lib.MAX_ACTIVE_IMPORTS)), JSON.stringify(envelope));
    });

    await section("B2) burst: 25 PUTs at once → exactly MAX admitted, the rest 429 with retryAfterSeconds and links kept", async () => {
      await reset();
      const MAX = lib.MAX_ACTIVE_IMPORTS;
      const links = [];
      for (let i = 0; i < 25; i += 1) links.push(await issue(owner.id, "video"));
      const results = await Promise.all(links.map((l) => put(l.token, mp4Of(32 * 1024))));
      const admitted = results.filter((r) => r.status === 202).length;
      const refused = results.filter((r) => r.status === 429);
      check(`25 concurrent PUTs → exactly ${MAX} × 202`, admitted === MAX, JSON.stringify(results.map((r) => r.status)));
      check(`…the other ${25 - MAX} → 429 too_many_active_imports with retryAfterSeconds`, refused.length === 25 - MAX
        && refused.every((r) => r.body.code === "too_many_active_imports" && r.body.retryAfterSeconds === limits.ACTIVE_IMPORT_RETRY_SECONDS),
        JSON.stringify(refused.slice(0, 2)));
      const unused = (await Promise.all(links.map((l) => linkUnused(l.importId)))).filter(Boolean).length;
      check("…and their links are kept for the retry", unused === 25 - MAX, String(unused));
    });

    // ── C. per-user byte budget ────────────────────────────────────────────────────────────
    await section("C1) rolling hour: refused at create_upload_url and at the PUT, retryAfterSeconds, link kept", async () => {
      await reset();
      const early = await issue(owner.id, "video"); // issued while the user had used nothing
      // 4 × 500 MiB ready in the last hour = 2000 MiB of the 2048 MiB budget.
      await rows([50, 40, 30, 20].map((m) => ({ userId: owner.id, purpose: "presenter", bytes: 500 * MIB, createdAt: ago(m * MINUTE) })));
      const refused = await lib.issueUploadToken(owner.id, "video");
      check("video link (200 MB cap) would pass 2 GiB/h → import_bytes_hourly_limit", !refused.ok && refused.code === "import_bytes_hourly_limit", JSON.stringify(refused));
      check("…retryAfterSeconds = when the oldest 500 MiB leaves the hour (~600 s)", !refused.ok && near(refused.retryAfterSeconds, 600), JSON.stringify(refused));
      check("…no link row left", (await prisma.mcpUploadToken.count({ where: { userId: owner.id } })) === 1);
      check("an image link (20 MB cap) still fits", (await lib.issueUploadToken(owner.id, "image")).ok);
      const envelope = await tools.createUploadUrlTool(owner.id, { kind: "video" }) as Record<string, unknown>;
      check("tool envelope: G14, Thai + English message naming the budget, top-level retryAfterSeconds",
        checkFailureEnvelope(envelope).length === 0 && envelope.code === "import_bytes_hourly_limit" && near(envelope.retryAfterSeconds, 600)
          && String(envelope.message).includes("2 GB") && /hour/i.test(String(envelope.message)), JSON.stringify(envelope));

      const big = await put(early.token, mp4Of(1024), 150 * MIB);
      check("PUT declaring 150 MiB → 429 import_bytes_hourly_limit with retryAfterSeconds", big.status === 429 && big.body.code === "import_bytes_hourly_limit"
        && near(big.body.retryAfterSeconds, 600) && checkFailureEnvelope(big.body).length === 0, JSON.stringify(big));
      check("…link kept, no import row", (await linkUnused(early.importId)) && !(await prisma.mediaImport.findUnique({ where: { id: early.importId } })));
      const small = await put(early.token, mp4Of(4096));
      check("same link, small file declared → 202 (the declared size counts, not the 200 MB cap)", small.status === 202, JSON.stringify(small));
      const row = await prisma.mediaImport.findUnique({ where: { id: early.importId } });
      check("…the staged row records the bytes actually received", row?.bytes === 4096, String(row?.bytes));
    });

    await section("C2) rolling 24 h: refused with the day's retryAfterSeconds; rows older than 24 h do not count", async () => {
      await reset();
      // 6 × 500 MiB ready, 23 h … 18 h ago = 3000 MiB of the 3072 MiB day; nothing in the last hour.
      await rows(Array.from({ length: 6 }, (_, i) => ({ userId: owner.id, purpose: "presenter", bytes: 500 * MIB, createdAt: ago((23 - i) * HOUR) })));
      const refused = await lib.createUrlImport(owner.id, "https://media.example.test/p.mp4", new Date(), "presenter");
      check("presenter url import → import_bytes_daily_limit", !refused.ok && refused.code === "import_bytes_daily_limit", JSON.stringify(refused));
      check("…retryAfterSeconds = when the 23-h-old row leaves the day (~3600 s)", !refused.ok && near(refused.retryAfterSeconds, 3600), JSON.stringify(refused));
      check("…no import row created", (await prisma.mediaImport.count({ where: { userId: owner.id } })) === 6);
      const env = copy.admissionRefusal("import_bytes_daily_limit", "replace_broll_window", 3600) as Record<string, unknown>;
      check("replace_broll_window envelope names the tool to retry and the budget", checkFailureEnvelope(env).length === 0
        && String(env.next).includes("replace_broll_window") && String(env.message).includes("3 GB") && env.retryAfterSeconds === 3600, JSON.stringify(env));
      await prisma.mediaImport.updateMany({ where: { userId: owner.id }, data: { createdAt: ago(25 * HOUR) } });
      check("rows older than 24 h do not count", (await lib.createUrlImport(owner.id, "https://media.example.test/p.mp4", new Date(), "presenter")).ok);
    });

    await section("C3) both windows over → the refusal with the longer wait", async () => {
      await reset();
      // Hour: 4 × 500 MiB, the oldest 10 min ago → ~3000 s. Day: + 2 × 500 MiB, the oldest 23 h 55 m ago → ~300 s.
      await rows([
        ...[10, 9, 8, 7].map((m) => ({ userId: owner.id, purpose: "presenter", bytes: 500 * MIB, createdAt: ago(m * MINUTE) })),
        ...[0, 1].map((i) => ({ userId: owner.id, purpose: "presenter", bytes: 500 * MIB, createdAt: ago(23 * HOUR + 55 * MINUTE - i * HOUR) })),
      ]);
      const refused = await lib.issueUploadToken(owner.id, "video");
      check("hourly wait (~3000 s) beats the daily one (~300 s)", !refused.ok && refused.code === "import_bytes_hourly_limit" && near(refused.retryAfterSeconds, 3000), JSON.stringify(refused));
    });

    await section("C4) what counts: ready + live; failed and expired rows do not; an unknown size counts as the cap", async () => {
      await reset();
      await rows([
        { userId: owner.id, purpose: "presenter", status: "failed", bytes: 2000 * MIB, createdAt: ago(5 * MINUTE) },
        ...[1, 2, 3].map(() => ({ userId: owner.id, purpose: "presenter", status: "ready", bytes: null, createdAt: ago(5 * MINUTE) })),
        { userId: owner.id, purpose: "broll_video", status: "pending", bytes: null, source: "url", createdAt: ago(MINUTE) },
      ]);
      // counted: 0 (failed) + 3 × 500 MiB (ready, size unknown → cap) + 200 MiB (live url, unknown → cap) = 1700 MiB.
      const refused = await lib.issueUploadToken(owner.id, "presenter");
      check("1700 MiB counted + a 500 MB presenter > 2 GiB/h → refused", !refused.ok && refused.code === "import_bytes_hourly_limit", JSON.stringify(refused));
      await prisma.mediaImport.updateMany({ where: { userId: owner.id, status: "pending" }, data: { deadlineAt: ago(1000) } });
      check("the live row past its deadline stops counting → admitted", (await lib.issueUploadToken(owner.id, "presenter")).ok);
      await prisma.mediaImport.updateMany({ where: { userId: owner.id, status: "ready" }, data: { bytes: 10 * MIB } });
      await prisma.mediaImport.updateMany({ where: { userId: owner.id, status: "failed" }, data: { createdAt: ago(2 * MINUTE) } });
      check("ready rows with a known size count that size", (await lib.issueUploadToken(owner.id, "presenter")).ok);
      check("other users' bytes never count against me", (await lib.issueUploadToken(other.id, "presenter")).ok);
    });

    // ── D. fair share ──────────────────────────────────────────────────────────────────────
    await section("D1) staging share: my live imports may hold at most 1.5 GiB; refusal has retryAfterSeconds; link kept", async () => {
      await reset();
      const share = limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER;
      const early = await issue(owner.id, "video");
      // 4 staged uploads waiting for the lane: 1360 MiB live (share 1536 MiB).
      await rows([1, 2, 3, 4].map(() => ({ userId: owner.id, purpose: "broll_video", status: "pending", bytes: 340 * MIB })));
      await rows(Array.from({ length: 10 }, () => ({ userId: other.id, purpose: "presenter", status: "pending", bytes: 500 * MIB })));
      const presenter = await lib.issueUploadToken(owner.id, "presenter");
      check("1360 MiB live + 500 MB presenter > 1.5 GiB → active_import_bytes_limit", !presenter.ok && presenter.code === "active_import_bytes_limit", JSON.stringify(presenter));
      check("…retryAfterSeconds = the active-import hint", !presenter.ok && presenter.retryAfterSeconds === limits.ACTIVE_IMPORT_RETRY_SECONDS);
      check("a 20 MB image still fits my share (other users' 5 GB do not count against it)", (await lib.issueUploadToken(owner.id, "image")).ok);
      const envelope = await tools.createUploadUrlTool(owner.id, { kind: "presenter" }) as Record<string, unknown>;
      check("tool envelope: G14 + retryAfterSeconds + the share in the message", checkFailureEnvelope(envelope).length === 0
        && envelope.code === "active_import_bytes_limit" && String(envelope.message).includes(limits.formatImportBytes(share))
        && String(envelope.message).includes("1.5 GB") && typeof envelope.retryAfterSeconds === "number", JSON.stringify(envelope));
      const over = await put(early.token, mp4Of(1024), 200 * MIB);
      check("PUT declaring 200 MiB (1360 + 200 > 1536) → 429 active_import_bytes_limit, link kept",
        over.status === 429 && over.body.code === "active_import_bytes_limit" && typeof over.body.retryAfterSeconds === "number" && (await linkUnused(early.importId)), JSON.stringify(over));
      const fits = await put(early.token, mp4Of(2048), 150 * MIB);
      check("same link declaring 150 MiB (fits) → 202", fits.status === 202, JSON.stringify(fits));
      check("a url B-roll import (unknown size = 200 MB cap) is refused by the share",
        (await lib.createUrlImport(owner.id, "https://media.example.test/w.mp4")).ok === false);
    });

    await section("D2) nine greedy accounts cannot lock a tenth out", async () => {
      await reset();
      const hogs = [];
      for (let i = 0; i < 9; i += 1) hogs.push(await makeUser(`hog-${i}`));
      const admittedPerHog: number[] = [];
      for (const hog of hogs) {
        let admitted = 0;
        let lastCode = "";
        for (let i = 0; i < 6; i += 1) {
          const r = await lib.createUrlImport(hog.id, `https://media.example.test/${hog.id}-${i}.mp4`, new Date(), "presenter");
          if (r.ok) admitted += 1; else lastCode = r.code;
        }
        admittedPerHog.push(admitted);
        if (lastCode !== "active_import_bytes_limit") check(`${hog.id}: refused by its share`, false, lastCode);
      }
      const perHog = Math.floor(limits.MAX_ACTIVE_IMPORT_BYTES_PER_USER / lib.MAX_PRESENTER_IMPORT_BYTES);
      check(`each greedy account holds ${perHog} × 500 MB (its share), never more`, perHog === 3 && admittedPerHog.every((n) => n === perHog), JSON.stringify(admittedPerHog));
      const tenth = await makeUser("tenth");
      const r = await lib.createUrlImport(tenth.id, "https://media.example.test/tenth.mp4", new Date(), "presenter");
      check("a tenth account still gets a 500 MB presenter import", r.ok, JSON.stringify(r));
    });

    await section("D3) global budget counts real bytes (unknown = cap); still refuses storage_busy when full", async () => {
      await reset();
      const link = await issue(owner.id, "video");
      // Other users' staged uploads (2 per user, within their share) fill the budget to 100 MiB short.
      const target = limits.MAX_STAGED_IMPORT_BYTES - 100 * MIB;
      const sizes: number[] = [];
      for (let left = target; left > 0; left -= 300 * MIB) sizes.push(Math.min(300 * MIB, left));
      for (let i = 0; i < sizes.length; i += 2) {
        const u = await makeUser(`bulk-${i}`);
        await rows(sizes.slice(i, i + 2).map((bytes) => ({ userId: u.id, purpose: "broll_video", status: "pending", bytes })));
      }
      const presenter = await lib.issueUploadToken(owner.id, "presenter");
      check("budget − 100 MiB live + 500 MB > budget → storage_busy (no retryAfterSeconds: it depends on others)",
        !presenter.ok && presenter.code === "storage_busy" && presenter.retryAfterSeconds === undefined, JSON.stringify(presenter));
      const res = await put(link.token, mp4Of(1024), 150 * MIB);
      check("PUT declaring 150 MiB → 503 storage_busy, link kept", res.status === 503 && res.body.code === "storage_busy" && (await linkUnused(link.importId)), JSON.stringify(res));
      const ok = await put(link.token, mp4Of(1024), 100 * MIB);
      check(`same link declaring 100 MiB (exactly fills it: real bytes, not ${sizes.length} × 200 MB caps) → 202`, ok.status === 202, JSON.stringify(ok));
    });

    await section("D4) the share holds across two processes on one SQLite file", async () => {
      await reset();
      const racer = await makeUser("racer");
      const go = path.join(tmp, "go-share");
      const results = (await runChildren([
        { userId: racer.id, attempts: 4, goFile: go },
        { userId: racer.id, attempts: 4, goFile: go },
      ], go)).flat();
      check("exactly 3 of 8 presenter url imports admitted (3 × 500 MB ≤ 1.5 GiB)", results.filter((r) => r.ok).length === 3, JSON.stringify(results));
      check("the other 5 refused active_import_bytes_limit", results.filter((r) => r.code === "active_import_bytes_limit").length === 5, JSON.stringify(results));
      check("DB holds exactly 3 live imports for the racer", (await prisma.mediaImport.count({ where: { userId: racer.id, status: "pending" } })) === 3);
    });

    // ── E. disk floor counts in-flight bytes (follow-up 2) ─────────────────────────────────
    await section("E) PUT free-disk floor counts other uploads still streaming in; fail closed", async () => {
      await reset();
      const realStatfs = fs.statfsSync;
      const fakeFree = (free: number) => {
        (fs as { statfsSync: unknown }).statfsSync = (target: fs.PathLike) => ({ ...realStatfs(target), bsize: 1, bavail: free });
      };
      const link = await issue(owner.id, "video");
      try {
        fakeFree(staging.STAGING_MIN_FREE_BYTES + 300 * MIB);
        await rows([{ userId: other.id, purpose: "broll_video", status: "processing", source: "upload", bytes: 200 * MIB, claimedAt: null }]);
        const refused = await put(link.token, mp4Of(1024), 150 * MIB);
        check("free = floor + 300 MiB, 200 MiB still streaming in elsewhere, mine 150 MiB → 503 storage_busy",
          refused.status === 503 && refused.body.code === "storage_busy", JSON.stringify(refused));
        check("…link kept, nothing staged", (await linkUnused(link.importId)) && !fs.existsSync(staging.stagedUploadPath(link.importId)));
        await prisma.mediaImport.updateMany({ where: { userId: other.id }, data: { status: "pending" } });
        const ok = await put(link.token, mp4Of(1024), 150 * MIB);
        check("the other upload lands (its bytes are on disk now) → the same link is admitted", ok.status === 202, JSON.stringify(ok));
        const link2 = await issue(owner.id, "image");
        (fs as { statfsSync: unknown }).statfsSync = () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
        const broken = await put(link2.token, pngOf(1024));
        check("statfs failing → 503 storage_busy, link kept", broken.status === 503 && broken.body.code === "storage_busy" && (await linkUnused(link2.importId)), JSON.stringify(broken));
      } finally {
        (fs as { statfsSync: unknown }).statfsSync = realStatfs;
      }
    });

    // ── F. queue deadline, claim fairness, lane bytes ──────────────────────────────────────
    await section("F1) a queued import waits up to the queue deadline (30 min); the lane claim still gives 10 min", async () => {
      await reset();
      const before = Date.now();
      const url = await lib.createUrlImport(owner.id, "https://media.example.test/q.mp4");
      const urlRow = url.ok ? await prisma.mediaImport.findUnique({ where: { id: url.importId } }) : null;
      check("url import queued with deadline now + 30 min", !!urlRow && Math.abs(urlRow.deadlineAt.getTime() - before - limits.IMPORT_QUEUE_DEADLINE_MS) < 5_000, String(urlRow?.deadlineAt));
      const link = await issue(owner.id, "image");
      const res = await put(link.token, pngOf(1024));
      const upRow = await prisma.mediaImport.findUnique({ where: { id: link.importId } });
      check("staged upload queued with deadline now + 30 min", res.status === 202 && !!upRow && Math.abs(upRow.deadlineAt.getTime() - before - limits.IMPORT_QUEUE_DEADLINE_MS) < 5_000, String(upRow?.deadlineAt));
      const t = new Date();
      const claimed = await laneMod.claimNextMediaImport(t);
      check("claim resets the deadline to now + 10 min", !!claimed && claimed.deadlineAt.getTime() === t.getTime() + lib.IMPORT_DEADLINE_MS);
    });

    await section("F2) the lane claims fairly even when every user has a deep queue", async () => {
      await reset();
      // Every user queues a full burst (MAX_ACTIVE_IMPORTS), enough users that the queued rows
      // outnumber the claim's 200-row scan — the old "200 oldest rows" read never saw `late`.
      const depth = lib.MAX_ACTIVE_IMPORTS;
      const deep = [];
      for (let i = 0; i < Math.ceil(200 / depth) + 1; i += 1) deep.push(await makeUser(`deep-${i}`));
      const late = await makeUser("late");
      const users = deep.length + 1;
      const base = Date.now() - 20 * MINUTE;
      let s = 0;
      await rows(deep.flatMap((u) => Array.from({ length: depth }, () => ({
        userId: u.id, purpose: "broll_image", status: "pending", bytes: MIB, createdAt: new Date(base + (s += 1) * 1000), deadlineAt: new Date(Date.now() + 20 * MINUTE),
      }))));
      await rows([{ userId: late.id, purpose: "broll_image", status: "pending", bytes: MIB, createdAt: new Date(base + (s += 1) * 1000), deadlineAt: new Date(Date.now() + 20 * MINUTE) }]);
      const claimedUsers: string[] = [];
      for (let i = 0; i < users; i += 1) {
        const row = await laneMod.claimNextMediaImport();
        if (row) claimedUsers.push(row.userId);
      }
      check(`${users} claims serve ${users} different users, including the one queued behind ${deep.length * depth} older rows`,
        new Set(claimedUsers).size === users && claimedUsers.includes(late.id) && deep.length * depth > 200, JSON.stringify(claimedUsers));
      check("one lane slot per user still holds (one more claim finds nothing)", (await laneMod.claimNextMediaImport()) === null);
    });

    await section("F3) the lane records a url import's real size", async () => {
      await reset();
      const fetchedDir = path.join(tmp, "fetched");
      fs.mkdirSync(fetchedDir, { recursive: true, mode: 0o700 });
      const stocksDir = path.join(tmp, "stocks");
      fs.mkdirSync(stocksDir, { recursive: true });
      const created = await lib.createUrlImport(owner.id, "https://media.example.test/window.png");
      if (!created.ok) throw new Error(`fixture: ${created.code}`);
      const body = pngOf(12_345);
      const lane = laneMod.createMediaImportLane({
        pollMs: 20,
        watchdogMs: 60 * MINUTE,
        stocksDir,
        log: { info: () => undefined, error: () => undefined },
        fetchMedia: async () => {
          const file = path.join(fetchedDir, "media-import-window.png");
          fs.writeFileSync(file, body, { mode: 0o600 });
          return { path: file, kind: "image", ext: "png", mime: "image/png", bytes: body.length };
        },
        processStaged: async () => ({ ok: true, resultSrc: "/api/stocks/broll-upload-capacity-test.mp4", durationMs: 5000 }),
      });
      lane.start();
      const deadline = Date.now() + 20_000;
      let row = await prisma.mediaImport.findUniqueOrThrow({ where: { id: created.importId } });
      while (row.status !== "ready" && row.status !== "failed" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        row = await prisma.mediaImport.findUniqueOrThrow({ where: { id: created.importId } });
      }
      await lane.stop();
      check("ready, recorded as broll_image with the fetched byte count", row.status === "ready" && row.purpose === "broll_image" && row.bytes === body.length,
        `${row.status} ${row.purpose} ${row.bytes} ${row.errorCode}`);
    });

    // ── G. wiring ──────────────────────────────────────────────────────────────────────────
    await section("G) wiring: package.json, CI, additive schema column", async () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
      check("package.json exposes verify:media-import-capacity", /scripts\/verify-media-import-capacity\.ts/.test(pkg.scripts["verify:media-import-capacity"] ?? ""));
      const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
      check("ci.yml runs it", ci.includes("npm run verify:media-import-capacity"));
      const schema = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
      const model = schema.slice(schema.indexOf("model MediaImport {"), schema.indexOf("}", schema.indexOf("model MediaImport {")));
      check("MediaImport.bytes is a nullable Int (additive: prisma db push adds it, no backfill)", /\n\s+bytes\s+Int\?\s*\n/.test(model));
    });
  } finally {
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (process.argv[2] === CHILD_FLAG) {
  runChild().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else if (process.argv[2] === LIMITS_CHILD_FLAG) {
  runLimitsChild().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
