import assert from "assert";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { mediaWebStream } from "../src/lib/media-storage-support";
import { readFileSync, readdirSync, statSync } from "node:fs";

// HERO-7: serving a rendered MP4 threw `Invalid state: Controller is already
// closed` as an uncaught exception when a viewer disconnected mid-download.
// These checks pin the cancellation contract of the adapter that replaced
// Node's `Readable.toWeb`, and assert that no process-level exception escapes.

const escaped: unknown[] = [];
process.on("uncaughtException", (error) => escaped.push(error));
process.on("unhandledRejection", (reason) => escaped.push(reason));

function syntheticMedia(sizeBytes: number): Buffer {
  const bytes = Buffer.allocUnsafe(sizeBytes);
  for (let index = 0; index < sizeBytes; index += 1) bytes[index] = index % 251;
  return bytes;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function settle(): Promise<void> {
  // Let any post-cancellation read reject and be handled before we assert.
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "verify-media-stream-"));
  const filePath = path.join(directory, "synthetic.mp4");
  const media = syntheticMedia(2 * 1024 * 1024);
  await writeFile(filePath, media);

  try {
    // 1. A complete read still returns every byte, unchanged.
    const whole = await drain(mediaWebStream(createReadStream(filePath)));
    assert.strictEqual(whole.length, media.length, "full read length");
    assert(whole.equals(media), "full read must be byte-identical");

    // 2. A range read returns exactly the requested slice. Range correctness is
    //    what makes seeking work, so it must survive this change.
    const start = 1_000;
    const end = 100_999;
    const ranged = await drain(
      mediaWebStream(createReadStream(filePath, { start, end })),
    );
    assert.strictEqual(ranged.length, end - start + 1, "range read length");
    assert(
      ranged.equals(media.subarray(start, end + 1)),
      "range read must be byte-identical",
    );

    // 3. Cancelling mid-download destroys the source and throws nothing. This is
    //    the HERO-7 symptom.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const source = createReadStream(filePath, { highWaterMark: 4096 });
      const reader = mediaWebStream(source).getReader();
      await reader.read();
      await reader.cancel();
      await settle();
      assert(source.destroyed, "cancel must destroy the source stream");
    }

    // 4. Cancelling while a read is in flight, without awaiting it. This is the
    //    exact window where the Node adapter enqueues into a closed controller.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const source = createReadStream(filePath, { highWaterMark: 4096 });
      const reader = mediaWebStream(source).getReader();
      const pending = reader.read().catch(() => undefined);
      await reader.cancel();
      await pending;
      await settle();
      assert(source.destroyed, "cancel must destroy the source stream");
    }

    // 5. A genuine source failure still reaches the consumer. The fix must not
    //    turn read errors into silent truncation.
    const failing = new Readable({
      read() {
        this.destroy(new Error("disk read failed"));
      },
    });
    await assert.rejects(
      () => drain(mediaWebStream(failing)),
      /disk read failed/,
      "source errors must propagate to the consumer",
    );

    await settle();
    assert.deepStrictEqual(
      escaped,
      [],
      `no uncaught exception or unhandled rejection may escape: ${escaped
        .map(String)
        .join(", ")}`,
    );

    verifyNoRawToWebAdapter();

    console.log("verify-media-stream: 10/10 passed (402 cancellation cases, 0 raw toWeb adapters)");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * HERO-7, second pass. `mediaWebStream` was written to replace `Readable.toWeb`
 * because that adapter enqueues into a controller the consumer has already
 * released. The media, R2 and brand-asset paths were migrated — and
 * `/api/music/[filename]` was missed, so one range-serving route kept the
 * throwing adapter for six weeks while the issue was investigated against the
 * routes that had already been fixed.
 *
 * A helper only helps where it is used. This pins the invariant repo-wide so the
 * next streaming route cannot quietly reintroduce the same adapter: nothing under
 * src/ may hand a Node stream to `Readable.toWeb`.
 */
function verifyNoRawToWebAdapter(): void {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const source = readFileSync(full, "utf8");
      // The definition in media-storage-support.ts only names it in a comment.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/Readable\s*\.\s*toWeb\s*\(/.test(code)) offenders.push(full);
    }
  };
  walk(path.join(process.cwd(), "src"));
  assert.deepStrictEqual(
    offenders.map((file) => path.relative(process.cwd(), file)),
    [],
    "every streaming route must use mediaWebStream; Readable.toWeb drops the cancellation guard (HERO-7)",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
