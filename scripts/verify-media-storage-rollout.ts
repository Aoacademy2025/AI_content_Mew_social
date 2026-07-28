import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryMediaStorageAdapter,
  type MediaStorage,
} from "../src/lib/media-storage";
import {
  MediaDeleteBlockedError,
  RolloutMediaStorage,
  createRuntimeMediaStorage,
  type MediaStorageRolloutEvent,
} from "../src/lib/media-storage-rollout";
import { mediaStorageRuntimeConfig } from "../src/lib/media-storage-config";

function storage(root: string, name: string): InMemoryMediaStorageAdapter {
  return new InMemoryMediaStorageAdapter(path.join(root, name));
}

function failingStorage(base: MediaStorage, operation: "commit" | "open"): MediaStorage {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === operation) {
        return async () => {
          throw new Error(`${operation} failed`);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function body(read: Awaited<ReturnType<MediaStorage["open"]>>): Promise<string | null> {
  return read
    ? Buffer.from(await new Response(read.body).arrayBuffer()).toString("utf8")
    : null;
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "media-rollout-"));
  const sourcePath = path.join(root, "source.mp4");
  writeFileSync(sourcePath, "local-copy");
  const identity = { area: "renders" as const, filename: "rollout.mp4" };

  const localOnly = createRuntimeMediaStorage({}, {
    local: storage(root, "factory-local"),
  });
  await localOnly.commit({ identity, sourcePath });
  assert.equal(await body(await localOnly.open(identity)), "local-copy");

  const events: MediaStorageRolloutEvent[] = [];
  const local = storage(root, "shadow-local");
  const brokenRemote = failingStorage(storage(root, "shadow-remote"), "commit");
  const shadow = new RolloutMediaStorage({
    config: mediaStorageRuntimeConfig({ MEDIA_WRITE_MODE: "shadow" }),
    local,
    remoteWrite: brokenRemote,
    observe: (event) => events.push(event),
  });
  await shadow.commit({ identity, sourcePath });
  assert.equal(await body(await local.open(identity)), "local-copy");
  assert(events.some((event) => event.operation === "commit" && event.outcome === "failed"));

  const required = new RolloutMediaStorage({
    config: mediaStorageRuntimeConfig({ MEDIA_WRITE_MODE: "r2-required" }),
    local: storage(root, "required-local"),
    remoteWrite: brokenRemote,
  });
  await assert.rejects(required.commit({ identity, sourcePath }), /commit failed/);
  assert.equal(
    await body(await required.open(identity)),
    "local-copy",
    "a failed required upload still leaves the local safety copy",
  );

  const readLocal = storage(root, "read-local");
  const readRemote = storage(root, "read-remote");
  await readRemote.commit({ identity, sourcePath });
  const localThenR2 = new RolloutMediaStorage({
    config: mediaStorageRuntimeConfig({ MEDIA_READ_MODE: "local-r2" }),
    local: readLocal,
    remoteRead: readRemote,
  });
  assert.equal(await body(await localThenR2.open(identity)), "local-copy");
  assert.equal((await localThenR2.stat(identity))?.sizeBytes, 10);

  await readLocal.commit({ identity, sourcePath });
  const remoteFailure = new RolloutMediaStorage({
    config: mediaStorageRuntimeConfig({ MEDIA_READ_MODE: "r2-local" }),
    local: readLocal,
    remoteRead: failingStorage(readRemote, "open"),
  });
  assert.equal(await body(await remoteFailure.open(identity)), "local-copy");

  await assert.rejects(
    localThenR2.remove({ identity, expectedSha256: "0".repeat(64) }),
    MediaDeleteBlockedError,
  );

  console.log("PASS media storage rollout");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
