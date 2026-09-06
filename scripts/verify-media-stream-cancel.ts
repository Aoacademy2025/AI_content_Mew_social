import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pipeToNodeResponse } from "next/dist/server/pipe-readable";
import { S3Client } from "@aws-sdk/client-s3";
import { LocalMediaStorageAdapter } from "../src/lib/media-storage";
import { AwsR2ObjectClient, r2StorageConfigFromEnv } from "../src/lib/media-storage-r2";
import { mediaWebStream } from "../src/lib/media-storage-support";
import { serveMediaGet } from "../src/lib/media-serving";

async function deadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

async function verifyCancellation(file: string) {
  // A plain ReadableStream.from(nodeStream) leaks an unstarted iterator on cancel.
  for (const makeSource of [() => new Readable({ read() {} }), () => createReadStream(file)]) {
    for (const pendingRead of [false, true]) {
      const source = makeSource();
      const closed = new Promise<void>((resolve) => source.once("close", resolve));
      const reader = mediaWebStream(source).getReader();
      const pending = pendingRead ? reader.read() : null;
      await deadline(reader.cancel(), "cancel without available data");
      await deadline(closed, "canceled source close");
      assert.equal(source.destroyed, true);
      if (pending) assert.equal((await pending).done, true);
    }
  }

  // Real filesystem read + slow sink + cancellation during a resume/data cycle.
  // The old toWeb adapter throws an uncaught ERR_INVALID_STATE here. The child
  // process deliberately has NO exception handler, so that regression fails CI.
  for (let trial = 0; trial < 40; trial++) {
    const source = createReadStream(file);
    const closed = new Promise<void>((resolve) => source.once("close", resolve));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5);
    try {
      await assert.rejects(deadline(mediaWebStream(source).pipeTo(new WritableStream({
        async write() { await delay(1); },
      }, { highWaterMark: 1 }), { signal: abort.signal }), "aborted file pipe"),
      (error: Error) => error.name === "AbortError");
      await deadline(closed, "aborted file close");
      assert.equal(source.destroyed, true);
    } finally { clearTimeout(timer); source.destroy(); }
  }

  const failure = new Error("synthetic source failure");
  const broken = new Readable({ read() { this.destroy(failure); } });
  await assert.rejects(new Response(mediaWebStream(broken)).arrayBuffer(), (error) => error === failure);

  const earlyFailure = new Error("synthetic failure before consumer reads");
  const early = new Readable({ read() {} });
  const earlyBody = mediaWebStream(early);
  early.destroy(earlyFailure);
  await delay(5);
  await assert.rejects(new Response(earlyBody).arrayBuffer(), (error) => error === earlyFailure);

  let reads = 0;
  const bounded = new Readable({ highWaterMark: 16384, read() { reads++; this.push(Buffer.alloc(16384)); } });
  const reader = mediaWebStream(bounded).getReader();
  try {
    await reader.read();
    await delay(20);
    assert.ok(reads <= 3, `slow consumer must bound read-ahead, saw ${reads} reads`);
  } finally { await reader.cancel(); }
  assert.equal(bounded.destroyed, true);
  console.log("PASS stream cancellation: before read, pending read, 40 file aborts, source errors and backpressure");
}

async function verifyHttp(directory: string, bytes: Buffer) {
  const storage = new LocalMediaStorageAdapter({ renders: directory, stocks: directory });
  const identity = { area: "renders" as const, filename: "synthetic.mp4" };
  const pending = new Set<Promise<void>>();
  const handlerErrors: unknown[] = [];
  const server = createServer((request, response) => {
    const task = (async () => {
      const headers = new Headers();
      if (request.headers.range) headers.set("range", request.headers.range);
      const result = await serveMediaGet(new Request("http://localhost/api/renders/synthetic.mp4", { headers }), {
        ...identity, storage, cors: {}, cacheControl: "private",
      });
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, value));
      if (result.body) await pipeToNodeResponse(result.body, response);
      else response.end();
    })().catch((error) => { handlerErrors.push(error); response.destroy(); });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/renders/synthetic.mp4`;
  const fullHash = createHash("sha256").update(bytes).digest("hex");
  const rangeHash = createHash("sha256").update(bytes.subarray(256, 65792)).digest("hex");
  let full = 0, ranges = 0, disconnected = 0;
  async function request(mode: number) {
    await deadline(new Promise<void>((resolve, reject) => {
      const ranged = mode === 2 || mode === 4;
      const req = get(url, { headers: ranged ? { range: "bytes=256-65791" } : {} }, (res) => {
        try {
          assert.equal(res.statusCode, ranged ? 206 : 200);
          assert.equal(res.headers["content-length"], String(ranged ? 65536 : bytes.length));
          if (ranged) assert.equal(res.headers["content-range"], `bytes 256-65791/${bytes.length}`);
        } catch (error) { res.destroy(); reject(error); return; }
        // Pause before destroying to retain the real slow-client cancellation path.
        if (mode === 1) {
          res.pause();
          setTimeout(() => { disconnected++; res.destroy(); resolve(); }, 5);
          return;
        }
        const hash = createHash("sha256");
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          if (mode === 2 || mode === 3) {
            if (received === 0) { disconnected++; res.destroy(); resolve(); }
            received += chunk.length;
          } else { received += chunk.length; hash.update(chunk); }
        });
        res.on("end", () => {
          try {
            assert.equal(received, ranged ? 65536 : bytes.length);
            assert.equal(hash.digest("hex"), ranged ? rangeHash : fullHash);
            if (ranged) ranges++; else full++;
            resolve();
          } catch (error) { reject(error); }
        });
        res.on("error", (error: NodeJS.ErrnoException) => {
          if (![1, 2, 3].includes(mode) || error.code !== "ECONNRESET") reject(error);
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("HTTP request timed out")); });
    }), "HTTP client");
  }
  try {
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 4 }, (_, index) => request((batch * 4 + index) % 5)));
    }
    const invalid = await fetch(url, { headers: { range: `bytes=${bytes.length}-` } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), `bytes */${bytes.length}`);
    await invalid.arrayBuffer();
    await deadline(Promise.all(pending), "HTTP pipe handlers after disconnect");
    assert.equal(pending.size, 0);
    assert.deepEqual(handlerErrors, []);
    assert.deepEqual({ full, ranges, disconnected }, { full: 8, ranges: 8, disconnected: 24 });
    console.log("PASS HTTP stream: 8 full + 8 range SHA-256/length checks, 24 disconnects, 416, zero pending handlers");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function verifyR2Body() {
  const source = new Readable({ read() {} });
  let sdkConversions = 0;
  // AWS SDK Node bodies carry both Readable and transformToWebStream. Exercise
  // the real client boundary so that convenience method cannot bypass our fix.
  const body = Object.assign(source, { transformToWebStream() {
    sdkConversions++;
    return Readable.toWeb(source);
  } });
  const send = S3Client.prototype.send;
  S3Client.prototype.send = (async () => ({ Body: body, ContentLength: 10 })) as typeof send;
  try {
    const client = new AwsR2ObjectClient(r2StorageConfigFromEnv({
      R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "synthetic-test",
      R2_READ_ACCESS_KEY_ID: "fixture", R2_READ_SECRET_ACCESS_KEY: "x".repeat(32),
    }, "read"));
    const result = await client.get({ key: "fixture", start: 0, end: 9 });
    await deadline(result.body.cancel(), "R2 body cancel before first read");
    assert.equal(source.destroyed, true);
    assert.equal(sdkConversions, 0, "SDK Node bodies must use the cancellation-safe media adapter");
  } finally { S3Client.prototype.send = send; source.destroy(); }
  console.log("PASS R2 Node body cancellation without SDK adapter bypass");
}

async function child(directory: string) {
  const bytes = Buffer.alloc(96 * 1024 * 1024, Buffer.from([11, 29, 7, 113, 251]));
  const file = path.join(directory, "synthetic.mp4");
  await writeFile(file, bytes);
  await verifyCancellation(file);
  await verifyHttp(directory, bytes);
  await verifyR2Body();
}

async function main() {
  if (process.argv[2] === "--child") return child(process.argv[3]);
  // Parent owns cleanup even if the buggy Node adapter crashes the child.
  const directory = await mkdtemp(path.join(tmpdir(), "hero-stream-regression-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-media-stream-cancel.ts", "--child", directory], {
      stdio: "inherit", timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `media stream child failed (${result.signal ?? "exit"})`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
