import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { Webhook } from "svix";
import { prisma } from "@/lib/prisma";
import { BrandAssetError } from "@/lib/brand-assets.server";
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
  const { hardDeleteUserWithBrandAssets } = await import(
    "@/lib/account-hard-delete.server"
  );
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
    /hardDeleteUserWithBrandAssets\(user\.id\)/,
    "Clerk deletion delegates to the same hard-delete helper",
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
  assert.equal(
    await hardDeleteUserWithBrandAssets(ADMIN_DELETE_USER_ID),
    false,
    "admin hard-delete retry is an idempotent missing-user no-op",
  );
  assert.equal(
    await hardDeleteUserWithBrandAssets("brand-api-never-existed"),
    false,
    "hard deleting an unknown user is an idempotent no-op",
  );
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
    await verifyAdminHardDeleteRegression();
    console.log("brand-asset-api: admin hard delete passed");
    return;
  }

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
    await assert.rejects(
      clerkWebhookPost(
        clerkDeleteRequest("clerk-brand-api-delete-fail", "brand-delete-fail"),
      ),
      "a forced Prisma delete failure reaches the caller",
    );
    await access(failedDeletionPath);
    assert.notEqual(
      await prisma.user.findUnique({ where: { id: DELETE_FAIL_USER_ID } }),
      null,
      "a failed DB delete leaves both row and file intact",
    );
  } finally {
    await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS block_brand_api_user_delete");
  }

  await verifyAdminHardDeleteRegression();

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
