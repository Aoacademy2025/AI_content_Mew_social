// Run with: npm run verify:story-film-presenter-upload
// Security and lifecycle guard for mewshort's API-only Presenter upload.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uploader = readFileSync("scripts/upload-story-film-presenter.mjs", "utf8");
const route = readFileSync("src/app/api/internal/story-film-media/presenter-upload/route.ts", "utf8");
const grants = readFileSync("src/lib/story-film-presenter-upload-grant.server.ts", "utf8");
const internalMcp = readFileSync("src/app/api/story-film/[transport]/route.ts", "utf8");

assert.match(uploader, /openAsBlob/);
assert.match(uploader, /FormData/);
assert.match(uploader, /\/api\/internal\/story-film-media\/presenter-upload/);
assert.match(uploader, /STORY_FILM_UPLOAD_TOKEN/);
assert.match(uploader, /Authorization/);
assert.doesNotMatch(uploader, /x-heroai-service-secret/);
assert.doesNotMatch(uploader, /x-heroai-act-as/);
assert.match(route, /claimStoryFilmPresenterUploadGrant/);
assert.match(route, /uploadStoryFilmPresenter/);
assert.match(route, /completeStoryFilmPresenterUploadGrant/);
assert.match(grants, /randomBytes/);
assert.match(grants, /createHash/);
assert.match(grants, /consumedAt: null/);
assert.match(grants, /updateMany/);
assert.match(internalMcp, /"hero_story_film_create_presenter_upload"/);

const testDir = mkdtempSync(join(tmpdir(), "story-film-presenter-upload-"));
process.env.DATABASE_URL = `file:${join(testDir, "test.db")}`;
execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const {
    claimStoryFilmPresenterUploadGrant,
    createStoryFilmPresenterUploadGrant,
  } = await import("../src/lib/story-film-presenter-upload-grant.server");

  try {
    const owner = await prisma.user.create({
      data: {
        id: "mew-owner",
        name: "Mew",
        email: "duckyhero@gmail.com",
        plan: "BUSINESS",
      },
    });
    const issued = await createStoryFilmPresenterUploadGrant(owner.id, {
      originalName: "presenter.mp4",
      mimeType: "video/mp4",
      sizeBytes: 68_970_477,
    });
    const stored = await prisma.storyFilmPresenterUploadGrant.findUniqueOrThrow({
      where: { id: issued.grantId },
    });
    assert.notEqual(stored.tokenHash, issued.uploadToken);
    assert.ok(issued.expiresAt.getTime() > Date.now());

    const request = new Request("http://hero.test/api/internal/story-film-media/presenter-upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.uploadToken}` },
    });
    const claimed = await claimStoryFilmPresenterUploadGrant(request);
    assert.equal(claimed?.id, issued.grantId);
    assert.equal(claimed?.userId, owner.id);
    assert.equal(await claimStoryFilmPresenterUploadGrant(request), null);

    await assert.rejects(
      createStoryFilmPresenterUploadGrant(owner.id, {
        originalName: "presenter.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
      }),
    );
  } finally {
    await prisma.$disconnect();
    rmSync(testDir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log("ok: Internal MCP issues a hashed, short-lived Presenter upload grant");
  console.log("ok: the bearer grant is owner-scoped and can be claimed only once");
  console.log("ok: mewshort streams media to Hero without browser auth or MCP media bytes");
});
