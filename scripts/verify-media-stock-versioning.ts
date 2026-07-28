import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryMediaStorageAdapter,
  contentAddressedStockIdentity,
  mediaObjectKey,
} from "../src/lib/media-storage";
import {
  AliasResolvingMediaStorage,
  MediaAliasMutationBlockedError,
} from "../src/lib/media-storage-alias";

const root = mkdtempSync(path.join(tmpdir(), "media-stock-versioning-"));

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function bodyText(body: ReadableStream<Uint8Array>): Promise<string> {
  return Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");
}

async function main() {
  const sourceRoot = path.join(root, "sources");
  mkdirSync(sourceRoot, { recursive: true });
  const firstPath = path.join(sourceRoot, "first.mp4");
  const secondPath = path.join(sourceRoot, "second.mp4");
  writeFileSync(firstPath, "first stock payload");
  writeFileSync(secondPath, "replacement stock payload");

  const logical = {
    area: "stocks" as const,
    filename: "stock-user-slot.mp4",
  };
  const firstPhysical = contentAddressedStockIdentity(
    logical,
    sha256("first stock payload"),
  );
  const secondPhysical = contentAddressedStockIdentity(
    logical,
    sha256("replacement stock payload"),
  );

  assert.notEqual(
    mediaObjectKey(firstPhysical),
    mediaObjectKey(secondPhysical),
    "the same logical stock filename with different bytes needs distinct immutable keys",
  );

  const remote = new InMemoryMediaStorageAdapter(path.join(root, "materialized"));
  await remote.commit({ identity: firstPhysical, sourcePath: firstPath });
  await remote.commit({ identity: secondPhysical, sourcePath: secondPath });

  const first = await remote.open(firstPhysical);
  const second = await remote.open(secondPhysical);
  assert(first);
  assert(second);
  assert.equal(await bodyText(first.body), "first stock payload");
  assert.equal(await bodyText(second.body), "replacement stock payload");

  const aliases = new AliasResolvingMediaStorage(remote, {
    resolveRemoteIdentity: async (identity) =>
      identity.area === logical.area && identity.filename === logical.filename
        ? secondPhysical
        : null,
  });
  const current = await aliases.open(logical);
  assert(current);
  assert.deepEqual(current.descriptor.identity, logical);
  assert.equal(current.descriptor.canonicalUrl, "/api/stocks/stock-user-slot.mp4");
  assert.equal(await bodyText(current.body), "replacement stock payload");
  assert.equal(
    await bodyText((await remote.open(firstPhysical))!.body),
    "first stock payload",
    "publishing a replacement alias must preserve the prior immutable blob",
  );
  await assert.rejects(
    aliases.commit({ identity: logical, sourcePath: firstPath }),
    MediaAliasMutationBlockedError,
  );

  console.log("PASS media stock content-addressed versioning");
}

main()
  .finally(() => rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
