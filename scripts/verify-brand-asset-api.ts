import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { Webhook } from "svix";
import { prisma } from "@/lib/prisma";
import {
  BrandAssetError,
  removeBrandAssetDirectoryForUser,
  saveBrandAsset,
} from "@/lib/brand-assets.server";
import {
  deleteClerkUserAndBrandAssetDirectory,
  deleteUserAndBrandAssetDirectory,
  hardDeleteUserWithBrandAssets,
} from "@/lib/account-hard-delete.server";
import {
  createClerkAssetCleanupStore,
  type ClerkAssetCleanupPhase,
} from "@/lib/clerk-asset-cleanup-receipt.server";
import {
  deleteBrandAssetItem,
  getBrandAssetCollection,
  getBrandAssetImage,
  getBrandAssetItem,
  mapBrandAssetError,
  patchBrandAssetItem,
  postBrandAsset,
} from "@/lib/brand-asset-api.server";
import { POST as clerkWebhookPost } from "@/app/api/clerk-webhook/route";
import * as collectionRoute from "@/app/api/user/brand-assets/route";
import * as itemRoute from "@/app/api/user/brand-assets/[id]/route";
import * as imageRoute from "@/app/api/user/brand-assets/[id]/image/route";

const root = path.resolve(
  process.env.BRAND_ASSET_ROOT || "/tmp/heroai-brand-assets-api",
);

const OWNER_ID = "brand-api-owner";
const OTHER_ID = "brand-api-other";
const OWNER_ASSET_ID = "brand-api-owner-default";
const OWNER_SPARE_ASSET_ID = "brand-api-owner-spare";
const DELETE_USER_ID = "brand-api-delete";
const DELETE_FAIL_USER_ID = "brand-api-delete-fail";
const ADMIN_DELETE_USER_ID = "brand-api-admin-delete";
const ORDERING_DELETE_USER_ID = "brand-api-ordering-delete";
const DEFERRED_UPLOAD_USER_ID = "brand-api-deferred-upload";
const ORPHAN_DELETE_USER_ID = "brand-api-orphan-delete";
const CLERK_RM_RETRY_USER_ID = "brand-api-clerk-rm-retry";
const CLERK_WRITE_FAIL_USER_ID = "brand-api-clerk-write-fail";
const CLERK_CONCURRENT_USER_ID = "brand-api-clerk-concurrent";
const RECEIPTS_DIRECTORY_NAME = ".account-delete-receipts-v1";
const QUARANTINE_DIRECTORY_NAME = ".account-delete-quarantine-v1";
const RECEIPT_BINDING_DOMAIN = "heroai-clerk-brand-cleanup-v2";
const MAX_RECEIPT_BYTES = 1024;
const CLERK_SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

const errorCases = [
  ["plan_required", 403, "ฟีเจอร์โลโก้แบรนด์ใช้ได้เฉพาะแผน Pro หรือ Business"],
  ["project_not_found", 404, "ไม่พบโปรเจกต์"],
  ["unsupported_type", 415, "รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP"],
  ["payload_too_large", 413, "ไฟล์ใหญ่เกิน 5 MB"],
  ["empty_file", 400, "ไฟล์ว่างหรืออ่านไม่ได้"],
  ["corrupt_image", 422, "ไฟล์รูปภาพเสียหายหรืออ่านไม่ได้"],
  ["dimensions_too_large", 422, "ไฟล์มีความละเอียดสูงเกินไป (สูงสุด 4096×4096)"],
  ["asset_not_found", 404, "ไม่พบโลโก้แบรนด์"],
  ["asset_in_use", 409, "โลโก้นี้กำลังถูกใช้งานอยู่"],
  ["invalid_config", 400, "การตั้งค่าโลโก้ไม่ถูกต้อง"],
  ["rate_limited", 429, "อัปโหลดมากเกินไปในชั่วโมงนี้ กรุณาลองใหม่ภายหลัง"],
] as const;

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clerkReceiptIdentifier(clerkId: string): string {
  return sha256(clerkId);
}

function clerkReceiptPath(clerkId: string): string {
  return path.join(root, RECEIPTS_DIRECTORY_NAME, `${clerkReceiptIdentifier(clerkId)}.json`);
}

function clerkReceiptDocument(
  clerkId: string,
  userId: string,
  phase: ClerkAssetCleanupPhase = "prepared",
): string {
  return JSON.stringify({
    version: 2,
    clerkIdHash: clerkReceiptIdentifier(clerkId),
    userId,
    bindingHash: sha256(`${RECEIPT_BINDING_DOMAIN}\u0000${clerkId}\u0000${userId}`),
    phase,
  });
}

async function captureConsoleErrors<T>(task: () => Promise<T>): Promise<{
  result: T;
  logs: string[];
}> {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  };
  try {
    return { result: await task(), logs };
  } finally {
    console.error = original;
  }
}

function assertNoStorageData(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /storageKey/);
  assert.equal(serialized.includes(root), false, "response must not expose the asset root");
}

async function seed(): Promise<void> {
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [
          OWNER_ID,
          OTHER_ID,
          DELETE_USER_ID,
          DELETE_FAIL_USER_ID,
          ADMIN_DELETE_USER_ID,
          ORDERING_DELETE_USER_ID,
          DEFERRED_UPLOAD_USER_ID,
          ORPHAN_DELETE_USER_ID,
          CLERK_RM_RETRY_USER_ID,
          CLERK_WRITE_FAIL_USER_ID,
          CLERK_CONCURRENT_USER_ID,
        ],
      },
    },
  });
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, OWNER_ID), { recursive: true });

  await prisma.user.createMany({
    data: [
      { id: OWNER_ID, name: "Owner", email: "brand-api-owner@example.test", plan: "FREE" },
      { id: OTHER_ID, name: "Other", email: "brand-api-other@example.test", plan: "PRO" },
    ],
  });
  await prisma.editorProject.create({
    data: { id: "brand-api-project", userId: OWNER_ID, title: "Logo project" },
  });
  await prisma.brandAsset.createMany({
    data: [
      {
        id: OWNER_ASSET_ID,
        userId: OWNER_ID,
        projectId: "brand-api-project",
        storageKey: `${OWNER_ID}/default.webp`,
        originalName: "default.png",
        mimeType: "image/webp",
        sizeBytes: 12,
        width: 120,
        height: 80,
      },
      {
        id: OWNER_SPARE_ASSET_ID,
        userId: OWNER_ID,
        projectId: "brand-api-project",
        storageKey: `${OWNER_ID}/spare.webp`,
        originalName: "spare.png",
        mimeType: "image/webp",
        sizeBytes: 10,
        width: 64,
        height: 64,
      },
    ],
  });
  await prisma.brandPreference.create({
    data: {
      userId: OWNER_ID,
      defaultAssetId: OWNER_ASSET_ID,
      enabled: true,
      position: "top-right",
      sizePct: 18,
      opacity: 0.9,
    },
  });
  await writeFile(path.join(root, OWNER_ID, "default.webp"), "owner-image");
  await writeFile(path.join(root, OWNER_ID, "spare.webp"), "spare-image");
}

function clerkDeleteRequest(clerkId: string, messageId: string): NextRequest {
  const body = JSON.stringify({
    type: "user.deleted",
    data: {
      id: clerkId,
      email_addresses: [],
      primary_email_address_id: "",
      first_name: null,
      last_name: null,
      image_url: null,
      public_metadata: {},
    },
  });
  const timestamp = new Date();
  const signature = new Webhook(CLERK_SECRET).sign(messageId, timestamp, body);
  return new NextRequest("http://local/api/clerk-webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "svix-id": messageId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
  });
}

async function createDeletionFixture(input: {
  userId: string;
  clerkId: string;
  filename: string;
}): Promise<string> {
  await prisma.user.create({
    data: {
      id: input.userId,
      clerkId: input.clerkId,
      name: input.userId,
      email: `${input.userId}@example.test`,
    },
  });
  await prisma.brandAsset.create({
    data: {
      id: `${input.userId}-asset`,
      userId: input.userId,
      storageKey: `${input.userId}/${input.filename}`,
      originalName: input.filename,
      mimeType: "image/webp",
      sizeBytes: 12,
      width: 10,
      height: 10,
    },
  });
  const filePath = path.join(root, input.userId, input.filename);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "delete-image");
  return filePath;
}

function verifyRouteExportContract(): void {
  assert.deepEqual(
    Object.keys(collectionRoute).sort(),
    ["GET", "POST"],
    "collection route exports only supported App Router entrypoints",
  );
  assert.deepEqual(
    Object.keys(itemRoute).sort(),
    ["DELETE", "GET", "PATCH"],
    "item route exports only supported App Router entrypoints",
  );
  assert.deepEqual(
    Object.keys(imageRoute).sort(),
    ["GET"],
    "image route exports only supported App Router entrypoints",
  );
}

async function verifyAdminHardDeleteRegression(): Promise<void> {
  const adminSource = await readFile(
    path.join(process.cwd(), "src/app/api/admin/users/[id]/route.ts"),
    "utf8",
  );
  const clerkSource = await readFile(
    path.join(process.cwd(), "src/app/api/clerk-webhook/route.ts"),
    "utf8",
  );
  assert.match(
    adminSource,
    /hardDeleteUserWithBrandAssets\(id\)/,
    "admin DELETE delegates to the shared idempotent hard-delete helper",
  );
  assert.match(
    clerkSource,
    /hardDeleteClerkUserWithBrandAssets\(data\.id\)/,
    "Clerk deletion delegates lookup and retry recovery to its strict shared helper",
  );
  const userDeletedBlock = clerkSource.slice(clerkSource.indexOf('if (type === "user.deleted")'));
  assert.doesNotMatch(
    userDeletedBlock,
    /prisma\.user\.findUnique\(\{ where: \{ clerkId: data\.id \} \}\)/,
    "the Clerk route does not discard missing-row receipt recovery before calling the helper",
  );

  const filePath = await createDeletionFixture({
    userId: ADMIN_DELETE_USER_ID,
    clerkId: "clerk-brand-api-admin-delete",
    filename: "admin-delete.webp",
  });
  assert.equal(
    await hardDeleteUserWithBrandAssets(ADMIN_DELETE_USER_ID),
    true,
    "admin hard delete reports a deleted user",
  );
  assert.equal(
    await prisma.user.findUnique({ where: { id: ADMIN_DELETE_USER_ID } }),
    null,
  );
  await assert.rejects(
    access(filePath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "admin hard delete removes captured brand files",
  );
  await assert.rejects(
    access(path.dirname(filePath)),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "the production hard-delete wrapper removes the exact user directory",
  );
  assert.equal(
    await hardDeleteUserWithBrandAssets(ADMIN_DELETE_USER_ID),
    false,
    "admin hard-delete retry preserves the missing-user boolean",
  );
  const orphanDirectory = path.join(root, ORPHAN_DELETE_USER_ID);
  await mkdir(orphanDirectory, { recursive: true });
  await writeFile(path.join(orphanDirectory, "orphan.webp"), "orphan-private-file");
  assert.equal(
    await hardDeleteUserWithBrandAssets(ORPHAN_DELETE_USER_ID),
    false,
    "a missing-user retry still reports that no database row was deleted",
  );
  await assert.rejects(
    access(orphanDirectory),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "a missing-user retry removes the safe orphan directory",
  );
  assert.equal(
    await hardDeleteUserWithBrandAssets("brand-api-never-existed"),
    false,
    "hard deleting an unknown user is an idempotent no-op",
  );
}

async function verifyDeleteThenCleanupOrdering(): Promise<void> {
  await prisma.user.create({
    data: {
      id: ORDERING_DELETE_USER_ID,
      name: "Ordering delete",
      email: "brand-api-ordering-delete@example.test",
    },
  });
  const userDirectory = path.join(root, ORDERING_DELETE_USER_ID);
  await mkdir(userDirectory, { recursive: true });
  await writeFile(path.join(userDirectory, "before-delete.webp"), "before-delete");

  const databaseDeleted = deferred();
  const allowDeleteToReturn = deferred();
  const events: string[] = [];
  let cleanupFailures = 0;
  const deletion = deleteUserAndBrandAssetDirectory(ORDERING_DELETE_USER_ID, {
    deleteUser: async (userId) => {
      events.push("delete:start");
      const deleted = await prisma.user.deleteMany({ where: { id: userId } });
      databaseDeleted.resolve();
      await allowDeleteToReturn.promise;
      events.push("delete:done");
      return deleted.count === 1;
    },
    removeUserDirectory: async (userId) => {
      events.push("cleanup:start");
      await removeBrandAssetDirectoryForUser(userId);
      events.push("cleanup:done");
    },
    reportCleanupFailure: () => {
      cleanupFailures += 1;
    },
  });

  await databaseDeleted.promise;
  assert.equal(
    await prisma.user.findUnique({ where: { id: ORDERING_DELETE_USER_ID } }),
    null,
    "the barrier opens only after the real database delete",
  );
  await mkdir(userDirectory, { recursive: true });
  const latePath = path.join(userDirectory, "created-before-delete-returned.webp");
  await writeFile(latePath, "late-private-file");
  allowDeleteToReturn.resolve();

  assert.equal(await deletion, true, "orchestration returns only the database deletion result");
  assert.deepEqual(
    events,
    ["delete:start", "delete:done", "cleanup:start", "cleanup:done"],
    "directory cleanup starts only after the delete dependency has settled",
  );
  assert.equal(cleanupFailures, 0);
  await assert.rejects(
    access(latePath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "post-delete cleanup removes a file created immediately before delete success returned",
  );

  let reported = 0;
  assert.equal(
    await deleteUserAndBrandAssetDirectory("cleanup-failure-user", {
      deleteUser: async () => false,
      removeUserDirectory: async () => {
        throw new Error("forced cleanup failure");
      },
      reportCleanupFailure: () => {
        reported += 1;
        throw new Error("forced reporter failure");
      },
    }),
    false,
    "cleanup failure does not change the database boolean",
  );
  assert.equal(reported, 1, "a cleanup failure is reported exactly once");
}

async function verifyDeferredUploadCannotOrphanFile(): Promise<void> {
  const projectId = `${DEFERRED_UPLOAD_USER_ID}-project`;
  await prisma.user.create({
    data: {
      id: DEFERRED_UPLOAD_USER_ID,
      name: "Deferred upload",
      email: "brand-api-deferred-upload@example.test",
      plan: "PRO",
    },
  });
  await prisma.editorProject.create({
    data: {
      id: projectId,
      userId: DEFERRED_UPLOAD_USER_ID,
      title: "Deferred upload project",
    },
  });

  const png = await sharp({
    create: { width: 16, height: 8, channels: 4, background: "#2468acee" },
  }).png().toBuffer();
  const arrayBufferStarted = deferred();
  const allowArrayBuffer = deferred();
  const file = new File([new Uint8Array(png)], "deferred.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => {
      arrayBufferStarted.resolve();
      await allowArrayBuffer.promise;
      return Uint8Array.from(png).buffer;
    },
  });

  const upload = saveBrandAsset({
    userId: DEFERRED_UPLOAD_USER_ID,
    plan: "PRO",
    projectId,
    file,
  });
  await arrayBufferStarted.promise;
  assert.equal(
    await hardDeleteUserWithBrandAssets(DEFERRED_UPLOAD_USER_ID),
    true,
    "the user is deleted while upload bytes are deferred",
  );
  allowArrayBuffer.resolve();
  await assert.rejects(upload, "the late asset insert fails after its user/project cascade");

  assert.equal(
    await prisma.brandAsset.count({ where: { userId: DEFERRED_UPLOAD_USER_ID } }),
    0,
    "the deferred upload cannot recreate its asset row",
  );
  const deferredDirectory = path.join(root, DEFERRED_UPLOAD_USER_ID);
  let entries: string[] = [];
  try {
    entries = await readdir(deferredDirectory);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  }
  assert.deepEqual(entries, [], "the failed late insert leaves no temporary or final private file");
}

async function verifyClerkCleanupStorePrimitives(): Promise<void> {
  const testBase = path.resolve(`${root}-trusted-cleanup-primitives`);
  const receiptsPath = (assetRoot: string, clerkId: string) => path.join(
    assetRoot,
    RECEIPTS_DIRECTORY_NAME,
    `${clerkReceiptIdentifier(clerkId)}.json`,
  );
  const quarantinePath = (assetRoot: string, clerkId: string) => path.join(
    assetRoot,
    QUARANTINE_DIRECTORY_NAME,
    clerkReceiptIdentifier(clerkId),
  );
  const expectPresent = async (target: string, message: string) => {
    await access(target).catch(() => assert.fail(message));
  };
  const expectMissing = async (target: string, message: string) => {
    await assert.rejects(
      access(target),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      message,
    );
  };

  await rm(testBase, { recursive: true, force: true });
  try {
    const durabilityParent = path.join(testBase, "durability-parent");
    const durabilityRoot = path.join(durabilityParent, "asset-root");
    await mkdir(durabilityParent, { recursive: true, mode: 0o700 });
    await chmod(durabilityParent, 0o700);
    const durabilitySteps: string[] = [];
    const durabilityStore = createClerkAssetCleanupStore({
      assetRoot: durabilityRoot,
      observeDurabilityStep: (step) => durabilitySteps.push(step),
    });
    const durabilityClerkId = "clerk-trusted-cleanup-durability";
    const durabilityUserId = "trusted-cleanup-durability-user";
    await durabilityStore.write(durabilityClerkId, durabilityUserId, "prepared");
    durabilitySteps.push("database-delete");
    assert.deepEqual(
      durabilitySteps.slice(0, 6),
      [
        "asset-root-created",
        "asset-root-parent-synced",
        "receipt-directory-created",
        "asset-root-synced",
        "receipt-file-synced",
        "receipt-directory-synced",
      ],
      "new root and receipt entries are parent-fsynced before database deletion",
    );
    assert.ok(
      durabilitySteps.indexOf("quarantine-directory-created")
        < durabilitySteps.indexOf("database-delete"),
      "the quarantine directory is created before database deletion",
    );
    assert.ok(
      durabilitySteps.lastIndexOf("asset-root-synced")
        < durabilitySteps.indexOf("database-delete"),
      "the quarantine parent entry is synced before database deletion",
    );
    assert.deepEqual(
      await durabilityStore.read(durabilityClerkId),
      {
        version: 2,
        clerkIdHash: clerkReceiptIdentifier(durabilityClerkId),
        userId: durabilityUserId,
        bindingHash: sha256(
          `${RECEIPT_BINDING_DOMAIN}\u0000${durabilityClerkId}\u0000${durabilityUserId}`,
        ),
        phase: "prepared",
      },
      "the store round-trips one canonical version-2 receipt",
    );
    assert.equal((await stat(durabilityRoot)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(durabilityRoot, RECEIPTS_DIRECTORY_NAME))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await stat(path.join(durabilityRoot, QUARANTINE_DIRECTORY_NAME))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await stat(receiptsPath(durabilityRoot, durabilityClerkId))).mode & 0o777,
      0o600,
    );

    const trustBase = path.join(testBase, "trust-boundary");
    await mkdir(trustBase, { recursive: true, mode: 0o700 });
    await chmod(trustBase, 0o700);

    const symlinkOutside = path.join(trustBase, "root-symlink-outside");
    const symlinkRoot = path.join(trustBase, "root-symlink");
    const symlinkSibling = path.join(trustBase, "root-symlink-sibling");
    await mkdir(symlinkOutside, { mode: 0o700 });
    await mkdir(symlinkSibling, { mode: 0o700 });
    await writeFile(path.join(symlinkOutside, "outside-sentinel"), "outside");
    await writeFile(path.join(symlinkOutside, "root-sentinel"), "root");
    await writeFile(path.join(symlinkSibling, "sibling-sentinel"), "sibling");
    await symlink(symlinkOutside, symlinkRoot);
    await assert.rejects(
      createClerkAssetCleanupStore({ assetRoot: symlinkRoot }).write(
        "clerk-root-symlink",
        "root-symlink-user",
        "prepared",
      ),
      "a configured root symlink fails closed",
    );
    await expectPresent(path.join(symlinkOutside, "outside-sentinel"), "root symlink preserves outside data");
    await expectPresent(path.join(symlinkOutside, "root-sentinel"), "root symlink preserves root data");
    await expectPresent(path.join(symlinkSibling, "sibling-sentinel"), "root symlink preserves sibling data");

    const writableRoot = path.join(trustBase, "writable-root");
    const writableOutside = path.join(trustBase, "writable-root-outside");
    const writableSibling = path.join(trustBase, "writable-root-sibling");
    await mkdir(writableRoot, { mode: 0o700 });
    await mkdir(writableOutside, { mode: 0o700 });
    await mkdir(writableSibling, { mode: 0o700 });
    await writeFile(path.join(writableRoot, "root-sentinel"), "root");
    await writeFile(path.join(writableOutside, "outside-sentinel"), "outside");
    await writeFile(path.join(writableSibling, "sibling-sentinel"), "sibling");
    await chmod(writableRoot, 0o722);
    await assert.rejects(
      createClerkAssetCleanupStore({ assetRoot: writableRoot }).write(
        "clerk-writable-root",
        "writable-root-user",
        "prepared",
      ),
      "a group/world-writable configured root fails closed",
    );
    await expectPresent(path.join(writableRoot, "root-sentinel"), "writable root preserves root data");
    await expectPresent(path.join(writableOutside, "outside-sentinel"), "writable root preserves outside data");
    await expectPresent(path.join(writableSibling, "sibling-sentinel"), "writable root preserves sibling data");
    await chmod(writableRoot, 0o700);

    for (const reservedDirectory of [RECEIPTS_DIRECTORY_NAME, QUARANTINE_DIRECTORY_NAME]) {
      const label = reservedDirectory === RECEIPTS_DIRECTORY_NAME ? "receipt" : "quarantine";
      const reservedRoot = path.join(trustBase, `${label}-symlink-root`);
      const reservedOutside = path.join(trustBase, `${label}-symlink-outside`);
      const reservedSibling = path.join(trustBase, `${label}-symlink-sibling`);
      await mkdir(reservedRoot, { mode: 0o700 });
      await mkdir(reservedOutside, { mode: 0o700 });
      await mkdir(reservedSibling, { mode: 0o700 });
      await writeFile(path.join(reservedRoot, "root-sentinel"), "root");
      await writeFile(path.join(reservedOutside, "outside-sentinel"), "outside");
      await writeFile(path.join(reservedSibling, "sibling-sentinel"), "sibling");
      await symlink(reservedOutside, path.join(reservedRoot, reservedDirectory));
      await assert.rejects(
        createClerkAssetCleanupStore({ assetRoot: reservedRoot }).write(
          `clerk-${label}-symlink`,
          `${label}-symlink-user`,
          "prepared",
        ),
        `${label} directory symlink fails closed`,
      );
      await expectPresent(path.join(reservedRoot, "root-sentinel"), `${label} symlink preserves root data`);
      await expectPresent(path.join(reservedOutside, "outside-sentinel"), `${label} symlink preserves outside data`);
      await expectPresent(path.join(reservedSibling, "sibling-sentinel"), `${label} symlink preserves sibling data`);
    }

    for (const reservedDirectory of [RECEIPTS_DIRECTORY_NAME, QUARANTINE_DIRECTORY_NAME]) {
      const label = reservedDirectory === RECEIPTS_DIRECTORY_NAME ? "receipt" : "quarantine";
      const reservedRoot = path.join(trustBase, `${label}-writable-root`);
      const reservedOutside = path.join(trustBase, `${label}-writable-outside`);
      const reservedSibling = path.join(trustBase, `${label}-writable-sibling`);
      await mkdir(reservedRoot, { mode: 0o700 });
      await mkdir(path.join(reservedRoot, reservedDirectory), { mode: 0o700 });
      await mkdir(reservedOutside, { mode: 0o700 });
      await mkdir(reservedSibling, { mode: 0o700 });
      await writeFile(path.join(reservedRoot, "root-sentinel"), "root");
      await writeFile(path.join(reservedOutside, "outside-sentinel"), "outside");
      await writeFile(path.join(reservedSibling, "sibling-sentinel"), "sibling");
      await chmod(path.join(reservedRoot, reservedDirectory), 0o722);
      await assert.rejects(
        createClerkAssetCleanupStore({ assetRoot: reservedRoot }).write(
          `clerk-${label}-writable`,
          `${label}-writable-user`,
          "prepared",
        ),
        `a group/world-writable ${label} directory fails closed`,
      );
      await expectPresent(path.join(reservedRoot, "root-sentinel"), `${label} mode rejection preserves root data`);
      await expectPresent(path.join(reservedOutside, "outside-sentinel"), `${label} mode rejection preserves outside data`);
      await expectPresent(path.join(reservedSibling, "sibling-sentinel"), `${label} mode rejection preserves sibling data`);
      await chmod(path.join(reservedRoot, reservedDirectory), 0o700);
    }

    if (typeof process.getuid === "function") {
      let foreignRoot: string | null = null;
      for (const candidate of ["/private/tmp", "/tmp"]) {
        try {
          const metadata = await lstat(candidate);
          if (
            metadata.isDirectory()
            && !metadata.isSymbolicLink()
            && metadata.uid !== process.getuid()
          ) {
            foreignRoot = candidate;
            break;
          }
        } catch {
          // The alternate platform path is absent.
        }
      }
      if (foreignRoot) {
        const foreignRootSentinel = path.join(foreignRoot, `.trusted-cleanup-root-${process.pid}`);
        const foreignSiblingSentinel = path.join(foreignRoot, `.trusted-cleanup-sibling-${process.pid}`);
        const foreignOutsideSentinel = path.join(testBase, "foreign-owner-outside-sentinel");
        await writeFile(foreignRootSentinel, "root");
        await writeFile(foreignSiblingSentinel, "sibling");
        await writeFile(foreignOutsideSentinel, "outside");
        try {
          await assert.rejects(
            createClerkAssetCleanupStore({ assetRoot: foreignRoot }).read("clerk-foreign-root"),
            "a configured root owned by another uid fails closed",
          );
          await expectPresent(foreignRootSentinel, "foreign-owner rejection preserves root data");
          await expectPresent(foreignSiblingSentinel, "foreign-owner rejection preserves sibling data");
          await expectPresent(foreignOutsideSentinel, "foreign-owner rejection preserves outside data");
        } finally {
          await rm(foreignRootSentinel, { force: true });
          await rm(foreignSiblingSentinel, { force: true });
        }
      }
    }

    const readRoot = path.join(testBase, "stable-read-root");
    let readBarrier: (() => void) | null = null;
    const readStore = createClerkAssetCleanupStore({
      assetRoot: readRoot,
      observeDurabilityStep: (step) => {
        if (step === "receipt-read-metadata" && readBarrier) {
          const barrier = readBarrier;
          readBarrier = null;
          barrier();
        }
      },
    });
    const readClerkId = "clerk-stable-receipt-read";
    const readUserId = "stable-receipt-read-user";
    const readReceiptPath = receiptsPath(readRoot, readClerkId);
    await readStore.write(readClerkId, readUserId, "prepared");
    const canonicalReceipt = await readFile(readReceiptPath, "utf8");
    const readSentinel = path.join(readRoot, "read-root-sentinel");
    const readSibling = `${readRoot}-sibling`;
    const readSiblingSentinel = path.join(readSibling, "sibling-sentinel");
    await writeFile(readSentinel, "root");
    await mkdir(readSibling, { mode: 0o700 });
    await writeFile(readSiblingSentinel, "sibling");

    const probeHandle = await open(readReceiptPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      read: (...args: any[]) => Promise<any>;
      readFile: (...args: any[]) => Promise<any>;
    };
    await probeHandle.close();
    const originalHandleRead = fileHandlePrototype.read;
    const originalHandleReadFile = fileHandlePrototype.readFile;
    const readCalls: Array<{ bufferLength: number; offset: number; length: number; position: number }> = [];
    fileHandlePrototype.read = async function (...args: any[]) {
      const [buffer, offset, length, position] = args as [Buffer, number, number, number];
      readCalls.push({ bufferLength: buffer.length, offset, length, position });
      return originalHandleRead.apply(this, args);
    };
    fileHandlePrototype.readFile = async () => {
      throw new Error("uncapped receipt read attempted");
    };
    try {
      assert.equal((await readStore.read(readClerkId))?.userId, readUserId);
    } finally {
      fileHandlePrototype.read = originalHandleRead;
      fileHandlePrototype.readFile = originalHandleReadFile;
    }
    assert.deepEqual(
      readCalls,
      [{ bufferLength: MAX_RECEIPT_BYTES + 1, offset: 0, length: MAX_RECEIPT_BYTES + 1, position: 0 }],
      "receipt reads use exactly one capped preallocated buffer and never FileHandle.readFile",
    );

    const assertUnstableReadRejected = async (
      mutate: () => void,
      label: string,
    ) => {
      await readStore.write(readClerkId, readUserId, "prepared");
      readBarrier = mutate;
      await assert.rejects(readStore.read(readClerkId), `${label} receipt fails closed`);
      readBarrier = null;
      await expectPresent(readSentinel, `${label} preserves root sentinel`);
      await expectPresent(readSiblingSentinel, `${label} preserves sibling sentinel`);
    };
    await assertUnstableReadRejected(
      () => appendFileSync(readReceiptPath, "x"),
      "concurrent append",
    );
    await assertUnstableReadRejected(
      () => truncateSync(readReceiptPath, Math.max(1, Buffer.byteLength(canonicalReceipt) - 1)),
      "concurrent truncate",
    );
    const replacedReceiptPath = `${readReceiptPath}.replaced`;
    await assertUnstableReadRejected(
      () => {
        renameSync(readReceiptPath, replacedReceiptPath);
        writeFileSync(readReceiptPath, canonicalReceipt, { mode: 0o600 });
        chmodSync(readReceiptPath, 0o600);
      },
      "concurrent pathname replacement",
    );
    await rm(replacedReceiptPath, { force: true });

    const directSymlinkTarget = path.join(readSibling, "direct-symlink-target");
    await writeFile(directSymlinkTarget, canonicalReceipt, { mode: 0o600 });
    await rm(readReceiptPath, { force: true });
    symlinkSync(directSymlinkTarget, readReceiptPath);
    await assert.rejects(readStore.read(readClerkId), "a direct receipt symlink fails closed");
    await expectPresent(directSymlinkTarget, "direct symlink rejection preserves its target");
    await expectPresent(readSentinel, "direct symlink rejection preserves root sentinel");
    await expectPresent(readSiblingSentinel, "direct symlink rejection preserves sibling sentinel");

    await rm(readReceiptPath, { force: true });
    await writeFile(readReceiptPath, Buffer.alloc(MAX_RECEIPT_BYTES + 1), { mode: 0o600 });
    await chmod(readReceiptPath, 0o600);
    await assert.rejects(readStore.read(readClerkId), "an oversized-at-open receipt fails closed");
    await expectPresent(readSentinel, "oversized receipt rejection preserves root sentinel");
    await expectPresent(readSiblingSentinel, "oversized receipt rejection preserves sibling sentinel");

    const assertReceiptContentsRejected = async (contents: string, label: string) => {
      await writeFile(readReceiptPath, contents, { mode: 0o600 });
      await chmod(readReceiptPath, 0o600);
      await assert.rejects(readStore.read(readClerkId), `${label} receipt fails closed`);
      await expectPresent(readSentinel, `${label} preserves root sentinel`);
      await expectPresent(readSiblingSentinel, `${label} preserves sibling sentinel`);
    };
    await assertReceiptContentsRejected("{malformed", "malformed");
    await assertReceiptContentsRejected(`${canonicalReceipt}\n`, "non-canonical whitespace");
    await assertReceiptContentsRejected(
      JSON.stringify({ ...JSON.parse(canonicalReceipt), bindingHash: "0".repeat(64) }),
      "binding mismatch",
    );
    await assertReceiptContentsRejected(
      JSON.stringify({ ...JSON.parse(canonicalReceipt), phase: "unknown" }),
      "unknown phase",
    );
    await writeFile(readReceiptPath, canonicalReceipt, { mode: 0o600 });
    await chmod(readReceiptPath, 0o620);
    await assert.rejects(readStore.read(readClerkId), "a group-writable receipt fails closed");
    await chmod(readReceiptPath, 0o600);

    const quarantineRoot = path.join(testBase, "quarantine-root");
    const quarantineStore = createClerkAssetCleanupStore({ assetRoot: quarantineRoot });
    const quarantineClerkId = "clerk-quarantine-exact-hash";
    const quarantineUserId = "quarantine-exact-user";
    await quarantineStore.write(quarantineClerkId, quarantineUserId, "prepared");
    const sourceDirectory = path.join(quarantineRoot, quarantineUserId);
    const sourceSentinel = path.join(sourceDirectory, "nested", "private.webp");
    await mkdir(path.dirname(sourceSentinel), { recursive: true, mode: 0o700 });
    await writeFile(sourceSentinel, "private");
    assert.equal(
      await quarantineStore.quarantineUserDirectory({
        clerkId: quarantineClerkId,
        userId: quarantineUserId,
      }),
      "moved",
      "the exact direct user child moves into quarantine",
    );
    const exactQuarantinePath = quarantinePath(quarantineRoot, quarantineClerkId);
    await expectMissing(sourceDirectory, "quarantine rename removes the original path");
    await expectPresent(
      path.join(exactQuarantinePath, "nested", "private.webp"),
      "quarantine retains the moved private file",
    );
    await expectMissing(
      path.join(quarantineRoot, QUARANTINE_DIRECTORY_NAME, quarantineUserId),
      "quarantine never derives its destination from the internal user id",
    );
    await mkdir(sourceDirectory, { mode: 0o700 });
    await writeFile(path.join(sourceDirectory, "live-sentinel"), "live");
    assert.equal(
      await quarantineStore.quarantineUserDirectory({
        clerkId: quarantineClerkId,
        userId: quarantineUserId,
      }),
      "already-quarantined",
      "an existing valid quarantine is idempotent",
    );
    await expectPresent(path.join(sourceDirectory, "live-sentinel"), "existing quarantine preserves a new original path");
    assert.equal(await quarantineStore.quarantineExists(quarantineClerkId), true);
    const quarantineSibling = path.join(
      quarantineRoot,
      QUARANTINE_DIRECTORY_NAME,
      "non-hash-sibling",
    );
    await mkdir(quarantineSibling, { mode: 0o700 });
    await writeFile(path.join(quarantineSibling, "sibling-sentinel"), "sibling");
    await quarantineStore.removeQuarantine(quarantineClerkId);
    assert.equal(await quarantineStore.quarantineExists(quarantineClerkId), false);
    await expectPresent(path.join(sourceDirectory, "live-sentinel"), "quarantine removal never touches the original path");
    await expectPresent(path.join(quarantineSibling, "sibling-sentinel"), "quarantine removal never touches a non-hash sibling");
    await rm(sourceDirectory, { recursive: true, force: true });
    assert.equal(
      await quarantineStore.quarantineUserDirectory({
        clerkId: quarantineClerkId,
        userId: quarantineUserId,
      }),
      "absent",
      "a missing source and quarantine is an idempotent absence",
    );

    const collisionClerkId = "clerk-quarantine-collision";
    const collisionUserId = "quarantine-collision-user";
    await quarantineStore.write(collisionClerkId, collisionUserId, "prepared");
    const collisionSource = path.join(quarantineRoot, collisionUserId);
    const collisionTarget = quarantinePath(quarantineRoot, collisionClerkId);
    await mkdir(collisionSource, { mode: 0o700 });
    await writeFile(path.join(collisionSource, "source-sentinel"), "source");
    await writeFile(collisionTarget, "collision", { mode: 0o600 });
    await assert.rejects(
      quarantineStore.quarantineUserDirectory({
        clerkId: collisionClerkId,
        userId: collisionUserId,
      }),
      "a non-directory quarantine collision fails closed",
    );
    await expectPresent(path.join(collisionSource, "source-sentinel"), "collision preserves the source directory");

    const sourceSymlinkClerkId = "clerk-quarantine-source-symlink";
    const sourceSymlinkUserId = "quarantine-source-symlink-user";
    const sourceSymlinkOutside = path.join(testBase, "quarantine-source-outside");
    await quarantineStore.write(sourceSymlinkClerkId, sourceSymlinkUserId, "prepared");
    await mkdir(sourceSymlinkOutside, { mode: 0o700 });
    await writeFile(path.join(sourceSymlinkOutside, "outside-sentinel"), "outside");
    await symlink(sourceSymlinkOutside, path.join(quarantineRoot, sourceSymlinkUserId));
    await assert.rejects(
      quarantineStore.quarantineUserDirectory({
        clerkId: sourceSymlinkClerkId,
        userId: sourceSymlinkUserId,
      }),
      "a direct-child source symlink fails closed",
    );
    await expectPresent(path.join(sourceSymlinkOutside, "outside-sentinel"), "source symlink rejection preserves outside data");

    const scavengerRoot = path.join(testBase, "scavenger-root");
    const scavengerStore = createClerkAssetCleanupStore({ assetRoot: scavengerRoot });
    const scavengerClerkId = "clerk-scavenge-own-temporaries";
    const scavengerUserId = "scavenge-own-temporaries-user";
    const scavengerIdentifier = scavengerStore.identifier(scavengerClerkId);
    const scavengerDirectory = path.join(scavengerRoot, RECEIPTS_DIRECTORY_NAME);
    await scavengerStore.write(scavengerClerkId, scavengerUserId, "prepared");
    for (let index = 0; index < 33; index += 1) {
      const uuid = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      await writeFile(
        path.join(scavengerDirectory, `.${scavengerIdentifier}.${uuid}.tmp`),
        "stale",
        { mode: 0o600 },
      );
    }
    await scavengerStore.write(scavengerClerkId, scavengerUserId, "quarantined");
    const ownTemporaryPattern = new RegExp(
      `^\\.${scavengerIdentifier}\\.[0-9a-f-]{36}\\.tmp$`,
      "u",
    );
    const remainingOwnTemporaries = (await readdir(scavengerDirectory)).filter((entry) => (
      ownTemporaryPattern.test(entry)
    ));
    assert.equal(
      remainingOwnTemporaries.length,
      1,
      "one call scavenges at most 32 matching stale temporary entries",
    );
    await rm(path.join(scavengerDirectory, remainingOwnTemporaries[0]), { force: true });

    const otherClerkId = "clerk-scavenge-other-receipt";
    const otherIdentifier = scavengerStore.identifier(otherClerkId);
    const otherTemporary = path.join(
      scavengerDirectory,
      `.${otherIdentifier}.11111111-1111-4111-8111-111111111111.tmp`,
    );
    const matchingSymlink = path.join(
      scavengerDirectory,
      `.${scavengerIdentifier}.ffffffff-ffff-4fff-8fff-ffffffffffff.tmp`,
    );
    const scavengerOutside = path.join(scavengerRoot, "scavenger-outside-sentinel");
    const nonMatchingTemporary = path.join(scavengerDirectory, ".unbound.tmp");
    await writeFile(otherTemporary, "other", { mode: 0o600 });
    await writeFile(scavengerOutside, "outside");
    await symlink(scavengerOutside, matchingSymlink);
    await writeFile(nonMatchingTemporary, "unbound", { mode: 0o600 });
    await scavengerStore.write(scavengerClerkId, scavengerUserId, "directory-cleaned");
    await expectPresent(otherTemporary, "scavenging preserves another receipt's temporary file");
    await expectPresent(matchingSymlink, "scavenging does not follow or unlink a temporary symlink");
    await expectPresent(scavengerOutside, "scavenging preserves a symlink target");
    await expectPresent(nonMatchingTemporary, "scavenging preserves a non-matching file");
  } finally {
    await rm(testBase, { recursive: true, force: true });
  }
}

async function verifyClerkPreparationRetryDurability(): Promise<void> {
  const testBase = path.resolve(`${root}-cleanup-preparation-retry`);
  const scenarios = [
    {
      label: "asset-root parent fsync",
      id: "root-parent",
      failurePoint: "first-created-parent",
      intermediateMissingComponent: false,
      precreateAssetRoot: false,
      expectVisibleReceipt: false,
      requireAssetRootParentRepair: true,
      requireAncestorChainRepair: false,
      requireQuarantineParentRepair: false,
    },
    {
      label: "intermediate asset-root parent fsync",
      id: "intermediate-parent",
      failurePoint: "first-created-parent",
      intermediateMissingComponent: true,
      precreateAssetRoot: false,
      expectVisibleReceipt: false,
      requireAssetRootParentRepair: true,
      requireAncestorChainRepair: true,
      requireQuarantineParentRepair: false,
    },
    {
      label: "post-rename receipt-directory fsync",
      id: "receipt-directory",
      failurePoint: "receipt-directory",
      intermediateMissingComponent: false,
      precreateAssetRoot: true,
      expectVisibleReceipt: true,
      requireAssetRootParentRepair: false,
      requireAncestorChainRepair: false,
      requireQuarantineParentRepair: false,
    },
    {
      label: "quarantine-parent fsync",
      id: "quarantine-parent",
      failurePoint: "quarantine-parent",
      intermediateMissingComponent: false,
      precreateAssetRoot: true,
      expectVisibleReceipt: true,
      requireAssetRootParentRepair: false,
      requireAncestorChainRepair: false,
      requireQuarantineParentRepair: true,
    },
  ] as const;

  await rm(testBase, { recursive: true, force: true });
  try {
    await mkdir(testBase, { recursive: true, mode: 0o700 });
    await chmod(testBase, 0o700);
    for (const scenario of scenarios) {
      const assetRoot = scenario.intermediateMissingComponent
        ? path.join(testBase, scenario.id, "asset-root")
        : path.join(testBase, scenario.id);
      if (scenario.precreateAssetRoot) {
        await mkdir(assetRoot, { mode: 0o700 });
        await chmod(assetRoot, 0o700);
      }
      const steps: string[] = [];
      const store = createClerkAssetCleanupStore({
        assetRoot,
        observeDurabilityStep: (step) => steps.push(step),
      });
      const clerkId = `clerk-preparation-retry-${scenario.id}`;
      const userId = `preparation-retry-user-${scenario.id}`;
      let target: { id: string; clerkId: string | null } | null = { id: userId, clerkId };
      let databaseDeletes = 0;
      let retrySyncCalls = 0;
      let retrySyncCallsAtDatabaseDelete = -1;
      const dependencies = {
        findUserByClerkId: async () => target,
        findUserById: async () => target,
        writeReceipt: (id: string, internalId: string) => store.write(id, internalId, "prepared"),
        readReceipt: async (id: string) => (await store.read(id))?.userId ?? null,
        deleteUser: async () => {
          steps.push("database-delete");
          retrySyncCallsAtDatabaseDelete = retrySyncCalls;
          databaseDeletes += 1;
          target = null;
          return true;
        },
        removeUserDirectory: async () => undefined,
        removeReceipt: (id: string) => store.remove(id),
      };

      let parentChainLength = 0;
      for (let current = path.dirname(assetRoot);;) {
        parentChainLength += 1;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      const failureSyncCall = scenario.failurePoint === "first-created-parent"
        ? 1
        : parentChainLength + (scenario.failurePoint === "receipt-directory" ? 3 : 4);

      const probeHandle = await open(testBase, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
        sync: (...args: any[]) => Promise<any>;
      };
      await probeHandle.close();
      const originalSync = fileHandlePrototype.sync;
      let syncCalls = 0;
      fileHandlePrototype.sync = async function (...args: any[]) {
        syncCalls += 1;
        if (syncCalls === failureSyncCall) {
          throw new Error(`injected ${scenario.label} failure`);
        }
        return originalSync.apply(this, args);
      };
      try {
        await assert.rejects(
          deleteClerkUserAndBrandAssetDirectory(clerkId, dependencies),
          new RegExp(`injected ${scenario.label} failure`, "u"),
          `${scenario.label} failure escapes before database deletion`,
        );
      } finally {
        fileHandlePrototype.sync = originalSync;
      }

      assert.equal(databaseDeletes, 0, `${scenario.label} failure blocks database deletion`);
      const receiptAfterFailure = await store.read(clerkId);
      if (scenario.expectVisibleReceipt) {
        assert.equal(
          receiptAfterFailure?.phase,
          "prepared",
          `${scenario.label} failure can leave a visible prepared receipt`,
        );
      } else {
        assert.equal(receiptAfterFailure, null, `${scenario.label} failure precedes receipt creation`);
        await access(scenario.intermediateMissingComponent ? path.dirname(assetRoot) : assetRoot);
      }
      if (scenario.requireQuarantineParentRepair) {
        assert.equal(
          await store.quarantineExists(clerkId),
          false,
          "the reserved quarantine directory exists but no user directory was moved",
        );
      }

      steps.length = 0;
      fileHandlePrototype.sync = async function (...args: any[]) {
        retrySyncCalls += 1;
        return originalSync.apply(this, args);
      };
      try {
        assert.equal(
          await deleteClerkUserAndBrandAssetDirectory(clerkId, dependencies),
          true,
          `${scenario.label} retry completes after repairing preparation durability`,
        );
      } finally {
        fileHandlePrototype.sync = originalSync;
      }
      const databaseDeleteIndex = steps.indexOf("database-delete");
      const receiptFileSyncIndex = steps.indexOf("receipt-file-synced");
      assert.ok(
        receiptFileSyncIndex >= 0 && receiptFileSyncIndex < databaseDeleteIndex,
        `${scenario.label} retry rewrites and fsyncs the receipt before database deletion`,
      );
      if (scenario.requireAssetRootParentRepair) {
        const assetRootParentSyncIndex = steps.indexOf("asset-root-parent-synced");
        assert.ok(
          assetRootParentSyncIndex >= 0 && assetRootParentSyncIndex < databaseDeleteIndex,
          "asset-root parent fsync retry repairs the visible root entry before database deletion",
        );
      }
      if (scenario.requireAncestorChainRepair) {
        assert.ok(
          retrySyncCallsAtDatabaseDelete >= parentChainLength + 5,
          "intermediate retry fsyncs the complete created-component parent chain before database deletion",
        );
      }
      if (scenario.requireQuarantineParentRepair) {
        const quarantineParentSyncIndex = steps.lastIndexOf("asset-root-synced");
        assert.ok(
          quarantineParentSyncIndex >= 0 && quarantineParentSyncIndex < databaseDeleteIndex,
          "quarantine-parent fsync retry repairs the visible directory entry before database deletion",
        );
      }
    }
  } finally {
    await rm(testBase, { recursive: true, force: true });
  }
}

async function verifyClerkReceiptRecovery(): Promise<void> {
  process.env.CLERK_WEBHOOK_SECRET = CLERK_SECRET;
  const receiptsDirectory = path.join(root, RECEIPTS_DIRECTORY_NAME);
  const ensurePrivateReceiptsDirectory = async () => {
    await mkdir(receiptsDirectory, { recursive: true, mode: 0o700 });
    await chmod(receiptsDirectory, 0o700);
  };
  const expectMissing = async (targetPath: string, message: string) => {
    await assert.rejects(
      access(targetPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      message,
    );
  };

  await ensurePrivateReceiptsDirectory();
  const retryClerkId = "clerk-brand-api-rm-retry";
  const retryFile = await createDeletionFixture({
    userId: CLERK_RM_RETRY_USER_ID,
    clerkId: retryClerkId,
    filename: "retry-private.webp",
  });
  let firstFailure: Awaited<ReturnType<typeof captureConsoleErrors<Response>>>;
  await chmod(root, 0o500);
  try {
    firstFailure = await captureConsoleErrors(() => clerkWebhookPost(
      clerkDeleteRequest(retryClerkId, "brand-delete-rm-retry-1"),
    ));
  } finally {
    await chmod(root, 0o700);
  }
  assert.equal(firstFailure.result.status, 500, "directory cleanup failure asks Clerk to retry");
  assert.equal(
    await prisma.user.findUnique({ where: { id: CLERK_RM_RETRY_USER_ID } }),
    null,
    "the real database row can already be gone when directory cleanup fails",
  );
  await access(retryFile);
  const retryReceipt = clerkReceiptPath(retryClerkId);
  await access(retryReceipt);
  assert.equal(
    (await stat(receiptsDirectory)).mode & 0o777,
    0o700,
    "the reserved receipts directory is private",
  );
  assert.equal((await stat(retryReceipt)).mode & 0o777, 0o600, "receipt files are private");
  const persistedReceipt = await readFile(retryReceipt, "utf8");
  assert.equal(persistedReceipt.includes(retryClerkId), false, "receipt never persists the raw Clerk id");
  const retryIdentifier = clerkReceiptIdentifier(retryClerkId);
  assert.ok(
    firstFailure.logs.some((entry) => entry.includes(retryIdentifier)),
    "cleanup failure logs the stable receipt hash",
  );
  const serializedFailureLogs = firstFailure.logs.join("\n");
  assert.equal(serializedFailureLogs.includes(retryClerkId), false, "failure log omits raw Clerk id");
  assert.equal(serializedFailureLogs.includes(CLERK_RM_RETRY_USER_ID), false, "failure log omits internal user id");
  assert.equal(serializedFailureLogs.includes(root), false, "failure log omits private filesystem paths");

  await chmod(receiptsDirectory, 0o500);
  let receiptRemovalFailure: Response;
  try {
    ({ result: receiptRemovalFailure } = await captureConsoleErrors(() => clerkWebhookPost(
      clerkDeleteRequest(retryClerkId, "brand-delete-rm-retry-2"),
    )));
  } finally {
    await chmod(receiptsDirectory, 0o700);
  }
  assert.equal(receiptRemovalFailure.status, 500, "receipt removal failure remains retryable");
  await expectMissing(
    path.dirname(retryFile),
    "missing-row redelivery still removes the exact private user directory",
  );
  await access(retryReceipt);

  const repairedResponse = await clerkWebhookPost(
    clerkDeleteRequest(retryClerkId, "brand-delete-rm-retry-3"),
  );
  assert.equal(repairedResponse.status, 200, "a later redelivery completes receipt cleanup");
  await expectMissing(retryReceipt, "successful repair removes its receipt");

  await ensurePrivateReceiptsDirectory();
  const writeFailClerkId = "clerk-brand-api-write-fail";
  const writeFailFile = await createDeletionFixture({
    userId: CLERK_WRITE_FAIL_USER_ID,
    clerkId: writeFailClerkId,
    filename: "write-fail-private.webp",
  });
  await chmod(receiptsDirectory, 0o500);
  let writeFailure: Response;
  try {
    ({ result: writeFailure } = await captureConsoleErrors(() => clerkWebhookPost(
      clerkDeleteRequest(writeFailClerkId, "brand-delete-write-fail-1"),
    )));
  } finally {
    await chmod(receiptsDirectory, 0o700);
  }
  assert.equal(writeFailure.status, 500, "a receipt write failure asks Clerk to retry");
  assert.notEqual(
    await prisma.user.findUnique({ where: { id: CLERK_WRITE_FAIL_USER_ID } }),
    null,
    "receipt durability failure occurs before database deletion",
  );
  await access(writeFailFile);
  await expectMissing(
    clerkReceiptPath(writeFailClerkId),
    "a failed atomic write exposes no final receipt",
  );
  assert.equal(
    (await clerkWebhookPost(clerkDeleteRequest(writeFailClerkId, "brand-delete-write-fail-2"))).status,
    200,
    "the event succeeds after receipt storage becomes writable",
  );

  await ensurePrivateReceiptsDirectory();
  const concurrentClerkId = "clerk-brand-api-concurrent";
  const concurrentFile = await createDeletionFixture({
    userId: CLERK_CONCURRENT_USER_ID,
    clerkId: concurrentClerkId,
    filename: "concurrent-private.webp",
  });
  await chmod(root, 0o500);
  try {
    const { result } = await captureConsoleErrors(() => clerkWebhookPost(
      clerkDeleteRequest(concurrentClerkId, "brand-delete-concurrent-1"),
    ));
    assert.equal(result.status, 500);
  } finally {
    await chmod(root, 0o700);
  }
  const concurrentReceipt = clerkReceiptPath(concurrentClerkId);
  await access(concurrentReceipt);
  const concurrentResponses = await Promise.all([
    clerkWebhookPost(clerkDeleteRequest(concurrentClerkId, "brand-delete-concurrent-2")),
    clerkWebhookPost(clerkDeleteRequest(concurrentClerkId, "brand-delete-concurrent-3")),
  ]);
  assert.deepEqual(
    concurrentResponses.map((response) => response.status),
    [200, 200],
    "duplicate missing-row redeliveries are idempotent",
  );
  await expectMissing(path.dirname(concurrentFile), "concurrent repair removes the exact user directory");
  await expectMissing(concurrentReceipt, "concurrent receipt removal is idempotent");

  await ensurePrivateReceiptsDirectory();
  const corruptClerkId = "clerk-brand-api-corrupt-receipt";
  const corruptReceipt = clerkReceiptPath(corruptClerkId);
  const rootSentinel = path.join(root, "receipt-root-sentinel.txt");
  const siblingDirectory = `${root}-receipt-sibling`;
  const siblingSentinel = path.join(siblingDirectory, "receipt-sibling-sentinel.txt");
  const otherUserDirectory = path.join(root, OTHER_ID);
  const otherUserSentinel = path.join(otherUserDirectory, "other-user-private.webp");
  const mismatchedTargetId = "brand-api-receipt-mismatched-target";
  const mismatchedTargetDirectory = path.join(root, mismatchedTargetId);
  const mismatchedTargetSentinel = path.join(mismatchedTargetDirectory, "keep-private.webp");
  await writeFile(rootSentinel, "keep-root");
  await mkdir(siblingDirectory, { recursive: true });
  await writeFile(siblingSentinel, "keep-sibling");
  await mkdir(otherUserDirectory, { recursive: true });
  await writeFile(otherUserSentinel, "keep-other-user");
  await mkdir(mismatchedTargetDirectory, { recursive: true });
  await writeFile(mismatchedTargetSentinel, "keep-mismatched-target");

  const assertReceiptRejected = async (contents: string, label: string) => {
    await writeFile(corruptReceipt, contents, { mode: 0o600 });
    await chmod(corruptReceipt, 0o600);
    const { result, logs } = await captureConsoleErrors(() => clerkWebhookPost(
      clerkDeleteRequest(corruptClerkId, `brand-delete-corrupt-${label}`),
    ));
    assert.equal(result.status, 500, `${label} receipt fails closed`);
    assert.ok(
      logs.some((entry) => entry.includes(clerkReceiptIdentifier(corruptClerkId))),
      `${label} failure uses the stable privacy-safe identifier`,
    );
    await access(rootSentinel);
    await access(siblingSentinel);
    await access(otherUserSentinel);
    await access(mismatchedTargetSentinel);
    assert.notEqual(
      await prisma.user.findUnique({ where: { id: OTHER_ID } }),
      null,
      `${label} receipt cannot delete another live user`,
    );
  };

  await assertReceiptRejected("{malformed", "malformed");
  await assertReceiptRejected(
    JSON.stringify({
      version: 2,
      clerkIdHash: "0".repeat(64),
      userId: mismatchedTargetId,
      bindingHash: sha256(`${RECEIPT_BINDING_DOMAIN}\u0000${corruptClerkId}\u0000${mismatchedTargetId}`),
      phase: "prepared",
    }),
    "mismatched-hash",
  );
  await assertReceiptRejected(
    JSON.stringify({
      version: 2,
      clerkIdHash: clerkReceiptIdentifier(corruptClerkId),
      userId: mismatchedTargetId,
      bindingHash: "0".repeat(64),
      phase: "prepared",
    }),
    "mismatched-binding",
  );
  const siblingEscape = `../${path.basename(siblingDirectory)}`;
  await assertReceiptRejected(
    clerkReceiptDocument(corruptClerkId, siblingEscape),
    "sibling-escape",
  );
  await assertReceiptRejected(
    clerkReceiptDocument(corruptClerkId, "."),
    "root-target",
  );
  await assertReceiptRejected(
    clerkReceiptDocument(corruptClerkId, RECEIPTS_DIRECTORY_NAME),
    "reserved-receipts-directory",
  );
  await assertReceiptRejected(
    clerkReceiptDocument(corruptClerkId, OTHER_ID),
    "other-live-user",
  );

  await rm(corruptReceipt, { force: true });
  await rm(siblingDirectory, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--route-contract") {
    verifyRouteExportContract();
    console.log("brand-asset-api: route export contract passed");
    return;
  }

  await seed();

  if (mode === "--admin-delete") {
    await verifyDeleteThenCleanupOrdering();
    await verifyDeferredUploadCannotOrphanFile();
    await verifyAdminHardDeleteRegression();
    console.log("brand-asset-api: admin hard delete passed");
    return;
  }

  await verifyClerkCleanupStorePrimitives();
  await verifyClerkPreparationRetryDurability();
  verifyRouteExportContract();

  for (const [code, status, message] of errorCases) {
    const mapped = mapBrandAssetError(new BrandAssetError(code, 599, "raw service message"));
    assert.deepEqual(mapped, {
      status,
      body: { error: code, message },
    });
  }
  assert.equal(mapBrandAssetError(new Error("untyped")), null);

  let formDataCalls = 0;
  const oversized = new Request("http://local/api/user/brand-assets", {
    method: "POST",
    headers: { "content-length": String(5 * 1024 * 1024 + 256 * 1024 + 1) },
  });
  Object.defineProperty(oversized, "formData", {
    value: async () => {
      formDataCalls += 1;
      throw new Error("formData must not be called for an oversized request");
    },
  });
  const oversizedResponse = await postBrandAsset(
    { id: OTHER_ID, plan: "PRO" },
    oversized,
  );
  assert.equal(oversizedResponse.status, 413);
  assert.equal((await json(oversizedResponse)).error, "payload_too_large");
  assert.equal(formDataCalls, 0, "content-length is rejected before formData()");

  const freeActor = { id: OWNER_ID, plan: "FREE" } as const;
  const paidOther = { id: OTHER_ID, plan: "PRO" } as const;

  const collectionResponse = await getBrandAssetCollection(freeActor);
  assert.equal(collectionResponse.status, 200);
  const collection = await json(collectionResponse);
  assert.equal(collection.eligible, false, "downgraded users retain read access");
  assert.equal(
    (collection.defaultLogo as { asset: { id: string } }).asset.id,
    OWNER_ASSET_ID,
  );
  assert.equal(
    (collection.defaultLogo as { asset: { imageUrl: string } }).asset.imageUrl,
    `/api/user/brand-assets/${OWNER_ASSET_ID}/image`,
  );
  assertNoStorageData(collection);

  const ownMetadataResponse = await getBrandAssetItem(freeActor, OWNER_ASSET_ID);
  assert.equal(ownMetadataResponse.status, 200, "FREE owner can read metadata");
  const ownMetadata = await json(ownMetadataResponse);
  assert.equal((ownMetadata.asset as { id: string }).id, OWNER_ASSET_ID);
  assertNoStorageData(ownMetadata);

  const ownImageResponse = await getBrandAssetImage(freeActor, OWNER_ASSET_ID);
  assert.equal(ownImageResponse.status, 200, "FREE owner can read image bytes");
  assert.equal(ownImageResponse.headers.get("content-type"), "image/webp");
  assert.equal(ownImageResponse.headers.get("cache-control"), "private, max-age=3600");
  assert.equal(ownImageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await ownImageResponse.text(), "owner-image");
  assertNoStorageData(Object.fromEntries(ownImageResponse.headers));

  const freeUploadResponse = await postBrandAsset(
    freeActor,
    new Request("http://local/api/user/brand-assets", { method: "POST" }),
  );
  assert.equal(freeUploadResponse.status, 403);
  assert.equal((await json(freeUploadResponse)).error, "plan_required");

  const freePatchResponse = await patchBrandAssetItem(
    freeActor,
    OWNER_ASSET_ID,
    new Request(`http://local/api/user/brand-assets/${OWNER_ASSET_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ setAsDefault: true }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(freePatchResponse.status, 403);
  assert.equal((await json(freePatchResponse)).error, "plan_required");

  const freeDeleteResponse = await deleteBrandAssetItem(freeActor, OWNER_SPARE_ASSET_ID);
  assert.equal(freeDeleteResponse.status, 403);
  assert.equal((await json(freeDeleteResponse)).error, "plan_required");

  const crossMetadata = await getBrandAssetItem(paidOther, OWNER_ASSET_ID);
  assert.equal(crossMetadata.status, 404);
  assert.equal((await json(crossMetadata)).error, "asset_not_found");

  const crossImage = await getBrandAssetImage(paidOther, OWNER_ASSET_ID);
  assert.equal(crossImage.status, 404);
  assert.equal((await json(crossImage)).error, "asset_not_found");

  const crossPatch = await patchBrandAssetItem(
    paidOther,
    OWNER_ASSET_ID,
    new Request(`http://local/api/user/brand-assets/${OWNER_ASSET_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        setAsDefault: true,
        enabled: true,
        position: "bottom-left",
        sizePct: 20,
        opacity: 0.75,
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(crossPatch.status, 404);
  assert.equal((await json(crossPatch)).error, "asset_not_found");

  const crossDelete = await deleteBrandAssetItem(paidOther, OWNER_SPARE_ASSET_ID);
  assert.equal(crossDelete.status, 404);
  assert.equal((await json(crossDelete)).error, "asset_not_found");

  const blankIdPatch = await patchBrandAssetItem(
    { id: OWNER_ID, plan: "PRO" },
    "  ",
    new Request("http://local/api/user/brand-assets/blank", {
      method: "PATCH",
      body: JSON.stringify({ setAsDefault: true }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(blankIdPatch.status, 400);
  assert.equal((await json(blankIdPatch)).error, "invalid_config");

  const normalizedPatch = await patchBrandAssetItem(
    { id: OWNER_ID, plan: "PRO" },
    OWNER_ASSET_ID,
    new Request(`http://local/api/user/brand-assets/${OWNER_ASSET_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        setAsDefault: true,
        enabled: false,
        position: "bottom-left",
        sizePct: 999,
        opacity: -1,
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(normalizedPatch.status, 200);
  const normalizedBody = await json(normalizedPatch);
  assert.deepEqual(
    (normalizedBody.defaultLogo as { config: unknown }).config,
    {
      enabled: false,
      assetId: OWNER_ASSET_ID,
      position: "bottom-left",
      sizePct: 35,
      opacity: 0.2,
    },
  );

  const invalidPatch = await patchBrandAssetItem(
    { id: OWNER_ID, plan: "PRO" },
    OWNER_ASSET_ID,
    new Request(`http://local/api/user/brand-assets/${OWNER_ASSET_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ setAsDefault: false }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(invalidPatch.status, 400);
  assert.equal((await json(invalidPatch)).error, "invalid_config");

  const inUseDelete = await deleteBrandAssetItem(
    { id: OWNER_ID, plan: "PRO" },
    OWNER_ASSET_ID,
  );
  assert.equal(inUseDelete.status, 409);
  assert.equal((await json(inUseDelete)).error, "asset_in_use");

  const png = await sharp({
    create: { width: 24, height: 12, channels: 4, background: "#336699ff" },
  }).png().toBuffer();
  const form = new FormData();
  form.set("projectId", "brand-api-project");
  form.set("file", new File([png], "new-logo.png", { type: "image/png" }));
  const uploadResponse = await postBrandAsset(
    { id: OWNER_ID, plan: "PRO" },
    new Request("http://local/api/user/brand-assets", { method: "POST", body: form }),
  );
  assert.equal(uploadResponse.status, 201);
  const uploaded = await json(uploadResponse);
  assert.equal((uploaded.asset as { mimeType: string }).mimeType, "image/webp");
  assert.match(
    (uploaded.asset as { imageUrl: string }).imageUrl,
    /^\/api\/user\/brand-assets\/[^/]+\/image$/,
  );
  assertNoStorageData(uploaded);

  process.env.CLERK_WEBHOOK_SECRET = CLERK_SECRET;
  const deletionPath = await createDeletionFixture({
    userId: DELETE_USER_ID,
    clerkId: "clerk-brand-api-delete",
    filename: "delete.webp",
  });
  const deletionResponse = await clerkWebhookPost(
    clerkDeleteRequest("clerk-brand-api-delete", "brand-delete-1"),
  );
  assert.equal(deletionResponse.status, 200);
  assert.equal(
    await prisma.user.findUnique({ where: { id: DELETE_USER_ID } }),
    null,
    "Clerk hard delete removes the user row",
  );
  await assert.rejects(
    access(deletionPath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "Clerk hard delete removes captured brand files after the DB delete",
  );
  await assert.rejects(
    access(clerkReceiptPath("clerk-brand-api-delete")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "successful Clerk cleanup removes its durable receipt",
  );
  const retryResponse = await clerkWebhookPost(
    clerkDeleteRequest("clerk-brand-api-delete", "brand-delete-2"),
  );
  assert.equal(retryResponse.status, 200, "Clerk delete retry stays successful");

  const failedDeletionPath = await createDeletionFixture({
    userId: DELETE_FAIL_USER_ID,
    clerkId: "clerk-brand-api-delete-fail",
    filename: "keep.webp",
  });
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER block_brand_api_user_delete
    BEFORE DELETE ON User
    WHEN OLD.id = '${DELETE_FAIL_USER_ID}'
    BEGIN
      SELECT RAISE(ABORT, 'forced delete failure');
    END
  `);
  try {
    const { result: failedDeleteResponse } = await captureConsoleErrors(() =>
      clerkWebhookPost(
        clerkDeleteRequest("clerk-brand-api-delete-fail", "brand-delete-fail"),
      ),
    );
    assert.equal(
      failedDeleteResponse.status,
      500,
      "a forced Prisma delete failure asks Clerk to retry",
    );
    await access(clerkReceiptPath("clerk-brand-api-delete-fail"));
    await access(failedDeletionPath);
    assert.notEqual(
      await prisma.user.findUnique({ where: { id: DELETE_FAIL_USER_ID } }),
      null,
      "a failed DB delete leaves both row and file intact",
    );
  } finally {
    await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS block_brand_api_user_delete");
  }
  assert.equal(
    (await clerkWebhookPost(
      clerkDeleteRequest("clerk-brand-api-delete-fail", "brand-delete-fail-retry"),
    )).status,
    200,
    "a database-failure receipt repairs on redelivery",
  );
  assert.equal(
    await prisma.user.findUnique({ where: { id: DELETE_FAIL_USER_ID } }),
    null,
  );
  await assert.rejects(
    access(clerkReceiptPath("clerk-brand-api-delete-fail")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  await assert.rejects(
    access(failedDeletionPath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  await verifyClerkReceiptRecovery();
  await verifyAdminHardDeleteRegression();
  await verifyDeleteThenCleanupOrdering();
  await verifyDeferredUploadCannotOrphanFile();

  console.log("brand-asset-api: all checks passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
