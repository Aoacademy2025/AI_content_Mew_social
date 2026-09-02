/** Brand Look Preview must never disclose a credit cost that differs from what
 * generation actually charges (audit 2026-09-02 §5, F1 and F2). Three things
 * have to hold together: the client always asks for a quote, it asks with the
 * same reuse lineage the generate call will use, and the quote route resolves
 * that lineage for the owner of the profile only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  blankPayload,
  createTempDatabase,
  draftPreviewIdentityKey,
  seedProfilePromotedFromClip,
  seedPublishedProfile,
  seedUser,
} from "./_brand-preview-harness";

createTempDatabase("brand-look-preview-quote-");

const QUOTE_ROUTE_FILE = "src/app/api/brand-library/preview-quote/route.ts";
const BRAND_LIBRARY_CLIENT_FILE = "src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx";

/** Quote and generate are two calls describing one intent. If they can be
 * built from different inputs, the disclosed number is fiction. */
async function verifyOneLineageForQuoteAndGenerate() {
  const { brandPreviewGenerateRequest, brandPreviewQuoteBody } =
    await import("../src/app/(dashboard)/brands/_components/preview-request-body");
  const payload = blankPayload("client");
  const sources = [
    { profileId: null, projectId: null, preflightId: null },
    { profileId: null, projectId: "project-1", preflightId: "preflight-1" },
    { profileId: null, projectId: "project-1", preflightId: null },
    { profileId: null, projectId: null, preflightId: "preflight-1" },
    { profileId: "brand-1", projectId: null, preflightId: null },
    { profileId: "brand-1", projectId: "project-1", preflightId: "preflight-1" },
    { profileId: "brand-1", projectId: null, preflightId: "preflight-1" },
  ];
  for (const source of sources) {
    const label = JSON.stringify(source);
    const { payload: quotedPayload, profileId, ...quotedLineage } =
      brandPreviewQuoteBody(source, payload);
    const generate = brandPreviewGenerateRequest(source, payload);
    const generatedLineage: Record<string, unknown> = { ...generate.body };
    delete generatedLineage.payload;

    assert.equal(quotedPayload, payload, `the quote must price the payload on screen (${label})`);
    assert.deepEqual(
      quotedLineage,
      generatedLineage,
      `quote and generate must resolve reuse from the same lineage (${label})`,
    );
    assert.equal(
      generate.endpoint,
      profileId ? `/api/brand-library/${profileId}/preview` : "/api/brand-library/preview",
      `the quoted profile must be the profile that generates (${label})`,
    );
    assert.equal(
      profileId ?? null,
      source.profileId,
      `a saved profile must be quoted as itself, never as an unsaved look (${label})`,
    );
    assert.equal(
      quotedLineage.useDraft,
      source.profileId ? true : undefined,
      `a saved profile previews its draft, so the quote must price the draft (${label})`,
    );
    assert.equal(
      "preflightId" in quotedLineage,
      Boolean(source.projectId && source.preflightId),
      `a preflight id without its project cannot widen the quoted reuse lineage (${label})`,
    );
  }
}

/** The disclosed number must come from the server on every surface. Hard-coding
 * three both overcharges the disclosure and can block a preview that would in
 * fact have cost nothing. */
function verifyClientAlwaysQuotes() {
  const source = readFileSync(BRAND_LIBRARY_CLIENT_FILE, "utf8");
  assert.ok(
    !/if\s*\(\s*!sourceProjectId\s*\)\s*\{\s*setPreviewGenerationCount\(\s*3\s*\)/u.test(source),
    "the quote must not be short-circuited to three when the look has no source project",
  );
  assert.match(
    source,
    /from\s+"\.\/preview-request-body"/u,
    "the client must build quote and generate calls from the shared lineage helper",
  );
  for (const helper of ["brandPreviewQuoteBody(", "brandPreviewGenerateRequest("]) {
    assert.ok(
      source.includes(helper),
      `BrandLibraryClient must call ${helper.slice(0, -1)} instead of assembling its own body`,
    );
  }
  assert.match(
    source,
    /AbortError[\s\S]{0,160}setPreviewGenerationCount\(\s*3\s*\)/u,
    "a failed quote must fall back to the worst case, never to a cheaper number",
  );
}

/** The quote route is the only place that turns a profile id into someone's
 * reuse history, so it owns the ownership check. */
function verifyQuoteRouteContract() {
  const source = readFileSync(QUOTE_ROUTE_FILE, "utf8");
  assert.match(source, /body\?\.profileId/u, "the quote route must accept profileId");
  assert.match(source, /body\?\.useDraft/u, "the quote route must accept useDraft");
  assert.match(
    source,
    /brandLookPreviewGenerationCount\(\{[\s\S]*?profileId,[\s\S]*?\}\)/u,
    "the quote route must price the requested profile, not a bare payload",
  );
  assert.match(
    source,
    /brandProfile\.findFirst\(\{[\s\S]*?userId:[\s\S]*?archivedAt:\s*null[\s\S]*?\}\)/u,
    "the quote route must resolve a profile only inside the caller's own library",
  );
  assert.match(
    source,
    /PROFILE_NOT_FOUND/u,
    "an unreachable profile must answer with one indistinguishable not-found code",
  );
  assert.match(
    source,
    /status:\s*404/u,
    "an unreachable profile must answer 404, never a cost quote",
  );
}

/** brandLookPreviewGenerationCount answers the safe worst case for a profile it
 * cannot see, which is exactly why it cannot double as an ownership check. */
async function verifyForeignProfileIsNotQuoted() {
  const { brandLookPreviewGenerationCount } = await import("../src/lib/brand-look-preview.server");
  const owner = await seedUser("-lineage-owner");
  const stranger = await seedUser("-lineage-stranger");
  const owned = await seedProfilePromotedFromClip(owner.id, "-owned", { reusableImages: 3 });
  assert.equal(
    await brandLookPreviewGenerationCount({ userId: owner.id, profileId: owned.profile.id }),
    0,
    "the owner reuses the three images their promoted clip already paid for",
  );
  assert.equal(
    await brandLookPreviewGenerationCount({ userId: stranger.id, profileId: owned.profile.id }),
    3,
    "a foreign profile silently prices as worst case, so the route must reject it itself",
  );
}

/** The invariant that actually protects credits: for every input set the client
 * can send, the quote equals the number of images generation will pay for. */
async function verifyQuoteEqualsCharge() {
  const {
    brandLookPreviewGenerationCount,
    prepareBrandLookPreview,
    prepareUnsavedBrandLookPreview,
  } = await import("../src/lib/brand-look-preview.server");
  const user = await seedUser("-quote");

  // A) An unsaved look with no source project pays for all three images.
  const payloadA = blankPayload("A");
  const quoteA = await brandLookPreviewGenerationCount({ userId: user.id, payload: payloadA });
  const prepA = await prepareUnsavedBrandLookPreview({
    userId: user.id,
    requestId: "quote-request-a",
    payload: payloadA,
  });
  assert.equal(quoteA, prepA.generationCount, "an unsaved look must be quoted at its charge");
  assert.equal(quoteA, 3, "with nothing to reuse the honest quote is three images");

  // B) A saved profile with no clip lineage: quoting the draft must match
  //    previewing the draft.
  const profileB = await seedPublishedProfile(user.id, "B");
  const quoteB = await brandLookPreviewGenerationCount({
    userId: user.id,
    payload: profileB.payload,
    profileId: profileB.profile.id,
    useDraft: true,
  });
  const prepB = await prepareBrandLookPreview({
    userId: user.id,
    requestId: "quote-request-b",
    profileId: profileB.profile.id,
    useDraft: true,
  });
  assert.equal(quoteB, prepB.generationCount, "a saved draft must be quoted at its charge");

  // C) A profile promoted from a completed clip reuses that clip's images. This
  //    is the case the client used to price at three images / six credits.
  const profileC = await seedProfilePromotedFromClip(user.id, "C", { reusableImages: 3 });
  const quoteC = await brandLookPreviewGenerationCount({
    userId: user.id,
    profileId: profileC.profile.id,
    useDraft: false,
  });
  const prepC = await prepareBrandLookPreview({
    userId: user.id,
    requestId: "quote-request-c",
    profileId: profileC.profile.id,
    useDraft: false,
  });
  assert.equal(quoteC, prepC.generationCount, "a published revision must be quoted at its charge");
  assert.ok(quoteC < 3, `a promoted profile must reuse images, got ${quoteC}`);

  // D) The exact shape the library sends: payload + profileId + useDraft, on a
  //    profile whose promoted clip already holds draft-preview images.
  const payloadD = blankPayload("D");
  const profileD = await seedProfilePromotedFromClip(user.id, "D", {
    reusableImages: 3,
    withDraft: true,
    identityKey: await draftPreviewIdentityKey(payloadD),
  });
  const quoteD = await brandLookPreviewGenerationCount({
    userId: user.id,
    payload: payloadD,
    profileId: profileD.profile.id,
    useDraft: true,
  });
  const prepD = await prepareBrandLookPreview({
    userId: user.id,
    requestId: "quote-request-d",
    profileId: profileD.profile.id,
    useDraft: true,
  });
  assert.equal(quoteD, prepD.generationCount, "the library's own quote must equal its own charge");
  assert.equal(quoteD, 0, "a draft whose images already exist must be quoted as free");
}

async function main() {
  await verifyOneLineageForQuoteAndGenerate();
  verifyClientAlwaysQuotes();
  verifyQuoteRouteContract();
  await verifyForeignProfileIsNotQuoted();
  await verifyQuoteEqualsCharge();
  console.log("verify-brand-look-preview-quote: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
