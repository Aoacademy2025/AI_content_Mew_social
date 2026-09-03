import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeHexColor, normalizeHexPalette } from "../src/lib/hex-color";

assert.equal(normalizeHexColor("#d29d00"), "#D29D00");
assert.equal(normalizeHexColor("ffd479"), "#FFD479");
assert.equal(normalizeHexColor("#abc"), "#AABBCC");
assert.equal(normalizeHexColor("rgb(255, 0, 0)"), null);
assert.equal(normalizeHexColor("#12GG00"), null);
assert.deepEqual(normalizeHexPalette(["#abc", "38bdf8"]), ["#AABBCC", "#38BDF8"]);
assert.equal(normalizeHexPalette(["warm paper white"]), null);
assert.equal(normalizeHexPalette([]), null);

const advanced = readFileSync("src/app/(dashboard)/brands/_components/AdvancedSettings.tsx", "utf8");
const brandList = readFileSync("src/app/(dashboard)/brands/_components/BrandList.tsx", "utf8");
const brandClient = readFileSync("src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx", "utf8");
const postPhase = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
const libraryRoute = readFileSync("src/app/api/brand-library/route.ts", "utf8");
const publishRoute = readFileSync("src/app/api/brand-library/[id]/publish/route.ts", "utf8");
const fromProjectLookRoute = readFileSync("src/app/api/brand-library/from-project-look/route.ts", "utf8");
const visualSuggestionRoute = readFileSync("src/app/api/brand-library/suggest-visual/route.ts", "utf8");
const archiveRoute = readFileSync("src/app/api/brand-library/[id]/route.ts", "utf8");
const previewServer = readFileSync("src/lib/brand-look-preview.server.ts", "utf8");
const heroScriptServer = readFileSync("src/lib/hero-script.server.ts", "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

assert.doesNotMatch(advanced, /type="color"/, "Brand palette never opens the browser RGB picker");
assert.match(advanced, /ตกลง/, "HEX input has an explicit Apply action");
assert.match(advanced, /data-brand-mark-preview="true"/, "Brand Mark settings include a live 9:16 preview");
assert.match(advanced, /\/api\/user\/brand-assets\/\$\{[^}]+\}\/image/, "logo preview uses the owned asset image endpoint");
assert.match(postPhase, /data-editor-function-tabs="true"[\s\S]{0,300}sticky/, "desktop function tabs stay pinned while controls scroll");
assert.match(brandList, /aria-label=\{`ลบแนวภาพ/, "each saved Brand exposes a visible delete action");
assert.match(brandClient, /method:\s*"DELETE"/, "Brand Library archives through an explicit DELETE request");
assert.match(archiveRoute, /archiveBrandProfile/, "the DELETE route delegates to the soft-delete domain seam");
assert.match(libraryRoute, /archivedAt:\s*null/, "archived Brands disappear from the active library");
assert.match(libraryRoute, /previewUrl:\s*visualFormatPreviewUrl\(format\.id\)/,
  "format cards use a content-versioned preview URL instead of retaining decoded stale images");
assert.match(visualSuggestionRoute, /six-digit HEX/i,
  "the AI helper explicitly requests six-digit HEX palette values");
assert.match(visualSuggestionRoute, /normalizeHexPalette/,
  "the AI helper rejects descriptive color prose even when the JSON shape is otherwise valid");
assert.match(brandClient, /normalizeHexPalette\(next\.palette\)/,
  "the client refuses a non-HEX proposal during a rolling deploy");
assert.match(previewServer, /where:\s*\{\s*id:\s*input\.profileId,\s*userId:\s*input\.userId,\s*archivedAt:\s*null\s*\}/,
  "archived Brands cannot start a new preview");
assert.match(heroScriptServer, /where:\s*\{\s*id:\s*brandProfileId,\s*userId,\s*archivedAt:\s*null\s*\}/,
  "archived Brands cannot seed new Hero Script work");
assert.match(schema, /archivedAt\s+DateTime\?/, "Brand Profile stores a recoverable archive timestamp");

// Task 3 (Brands wave 1 — Style Packs): /brands default surface = name +
// StylePackPicker; the two visual axes move under a collapsed "กำหนดเอง".
const stylePackPicker = readFileSync("src/app/(dashboard)/brands/_components/StylePackPicker.tsx", "utf8");
assert.match(stylePackPicker, /role="radio"/, "each Style Pack card is a radio button");
assert.match(stylePackPicker, /กำหนดเอง/, "a final card opts out to the custom (non-pack) look");
const stylePackPickerIndex = brandClient.indexOf("<StylePackPicker");
const advancedSettingsIndex = brandClient.indexOf("<AdvancedSettings");
assert.ok(
  stylePackPickerIndex > 0 && advancedSettingsIndex > stylePackPickerIndex,
  "the default /brands surface renders StylePackPicker before AdvancedSettings",
);

// Fix-up: applying the AI visual-helper proposal writes the same pack-owned
// axes (format/palette/personality) `updateVisual` guards — it must unlink a
// selected Style Pack too, never leave a half-pack silently behind.
const applyProposalBody = brandClient.slice(
  brandClient.indexOf("function applyProposal"),
  brandClient.indexOf("async function uploadBrandMark"),
);
assert.match(
  applyProposalBody,
  /clearStylePackIfLinked/,
  "applying the AI look proposal unlinks a selected Style Pack before writing its fields",
);

const panel = readFileSync("src/app/(dashboard)/brands/_components/BrandLookPreviewPanel.tsx", "utf8");
assert.match(panel, /ตั้งชื่อแบรนด์ก่อนจึงจะทดลองภาพได้/, "panel must explain the no-name disabled state");
assert.match(panel, /data-testid="preview-disabled-reason"/);

// ADR 0059: the Brand Library stays open to every plan, so nothing on the page
// may promise an image entitlement the button then refuses. The allowance card,
// the allowance cost label and the preview quote itself all sit behind the same
// image gate, and the gate reason outranks the quote spinner on the button.
const allowanceCardIndex = brandClient.indexOf("สิทธิ์ทดลองสร้างภาพ");
const headerIndex = brandClient.lastIndexOf("<header", allowanceCardIndex);
assert.ok(
  allowanceCardIndex > 0
    && brandClient.lastIndexOf("library.imageAccess.canUse", allowanceCardIndex) > headerIndex,
  "the starter-allowance card renders only for an account the image gate admits",
);
const quoteFetchIndex = brandClient.indexOf('"/api/brand-library/preview-quote"');
assert.ok(
  quoteFetchIndex > 0
    && brandClient.lastIndexOf("canQuotePreview", quoteFetchIndex)
      > brandClient.lastIndexOf("useEffect(", quoteFetchIndex),
  "the debounced preview quote never fires for an account the image gate rejects",
);
const costLabelBlock = panel.slice(panel.indexOf("const costLabel"), panel.indexOf("const fundingInsufficient"));
assert.ok(
  costLabelBlock.includes("imageAccess.canUse"),
  "the trial-allowance cost label is only offered to an account the image gate admits",
);
const reasonChain = panel.slice(panel.indexOf("const disabledReason"), panel.indexOf("return ("));
assert.ok(
  reasonChain.indexOf("!imageAccess.canUse") < reasonChain.indexOf("previewGenerationCount === null"),
  "a rejected account reads the image-gate reason instead of a quote that never arrives",
);

// Task 9 (Telemetry): style_pack_selected (surface: "brand") is emitted once
// a Brand carries a pack — on manual/"save as brand" creation (POST
// /api/brand-library) and on every publish (POST /api/brand-library/[id]/publish)
// — never on a draft autosave, and never when no pack is chosen. Both sites
// are server-sourced, next to the existing brand telemetry.
assert.match(
  libraryRoute,
  /parsed\.data\.visual\.stylePackId[\s\S]{0,400}name:\s*"style_pack_selected"[\s\S]{0,300}source:\s*"server"[\s\S]{0,300}surface:\s*"brand"/,
  "creating a Brand with a pack emits style_pack_selected (surface: brand), gated on a non-null stylePackId",
);
// Review fix (2026-09-03, Important finding 1): the publish route's earlier
// inline `JSON.parse(revision.payloadJson)` sat OUTSIDE any try/catch — a
// malformed/legacy payload would throw into the route's outer catch and
// report an already-successful publish as a failure. The whole parse+emit
// now goes through one fail-open shared helper.
assert.match(
  publishRoute,
  /emitStylePackSelectedFromRevision\(auth\.user\.id,\s*revision,\s*"brands\.publish"\)/,
  "publishing a Brand Revision emits style_pack_selected through the fail-open shared helper",
);
assert.doesNotMatch(
  publishRoute,
  /JSON\.parse\(revision\.payloadJson\)/,
  "the publish route never parses the persisted payload inline — a malformed/legacy payloadJson must never turn a successful publish into a reported failure",
);
assert.doesNotMatch(
  readFileSync("src/app/api/brand-library/[id]/draft/route.ts", "utf8"),
  /style_pack_selected/,
  "draft autosave never emits style_pack_selected — only publish/create do",
);
assert.match(
  fromProjectLookRoute,
  /!promoted\.replayed[\s\S]{0,600}name:\s*"style_pack_selected"[\s\S]{0,300}source:\s*"server"[\s\S]{0,300}surface:\s*"brand"/,
  "promoting a Project Look/completed clip to a Brand emits style_pack_selected (surface: brand) once per NEW profile, gated on !replayed",
);

console.log("Brand Library support-feature contracts passed");
