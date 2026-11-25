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

const paletteEditor = readFileSync("src/app/(dashboard)/brands/_components/BrandColorPaletteEditor.tsx", "utf8");
const liveStage = readFileSync("src/app/(dashboard)/brands/_components/BrandLiveStage.tsx", "utf8");
const workspace = readFileSync("src/app/(dashboard)/brands/_components/BrandStyleWorkspace.tsx", "utf8");
const overview = readFileSync("src/app/(dashboard)/brands/_components/BrandLibraryOverview.tsx", "utf8");
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

assert.doesNotMatch(paletteEditor, /type="color"/, "Brand palette never opens the browser RGB picker");
assert.doesNotMatch(workspace, /type="color"/, "Brand workspace never opens the browser RGB picker");
assert.match(paletteEditor, /ตกลง/, "HEX input has an explicit Apply action");
assert.match(liveStage, /data-brand-mark-preview["']?:\s*["']true["']|data-brand-mark-preview="true"/, "Live 9:16 Brand Stage includes the live Brand Mark preview");
assert.match(liveStage, /\/api\/user\/brand-assets\/\$\{[^}]+\}\/image/, "logo preview uses the owned asset image endpoint");
assert.match(postPhase, /data-editor-function-tabs="true"[\s\S]{0,300}sticky/, "desktop function tabs stay pinned while controls scroll");
assert.match(overview, /aria-label=\{`ลบแบรนด์/, "each saved Brand card exposes a visible delete action");
assert.match(overview, /\/hero-script\?brandId=/, "each saved Brand card links directly to Hero Script with ?brandId=");
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

// StylePackPicker contract (still used inside Video Editor BrandVisualSelector)
const stylePackPicker = readFileSync("src/app/(dashboard)/brands/_components/StylePackPicker.tsx", "utf8");
assert.match(stylePackPicker, /role="radio"/, "each Style Pack card is a radio button");
assert.match(stylePackPicker, /กำหนดเอง/, "a final card opts out to the custom (non-pack) look");
assert.ok(
  brandClient.includes("<BrandStyleWorkspace") && workspace.includes('role="tablist"'),
  "the /brands Studio renders the 4-tab BrandStyleWorkspace with live preview",
);

// ADR 0058: applying the AI visual-helper proposal unlinks a selected Style Pack
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

// ADR 0059: the Brand Library stays open to every plan; paid/rollout gates live on AI-image actions only
assert.doesNotMatch(brandClient, /สิทธิ์ทดลองสร้างภาพ/, "the primary setup surface no longer leads with paid-image funding");
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

// Telemetry contracts
assert.match(
  libraryRoute,
  /parsed\.data\.visual\.stylePackId[\s\S]{0,400}name:\s*"style_pack_selected"[\s\S]{0,300}source:\s*"server"[\s\S]{0,300}surface:\s*"brand"/,
  "creating a Brand with a pack emits style_pack_selected (surface: brand), gated on a non-null stylePackId",
);
assert.match(
  publishRoute,
  /emitStylePackSelectedFromRevision\(auth\.user\.id,\s*revision,\s*"brands\.publish"\)/,
  "publishing a Brand Revision emits style_pack_selected through the fail-open shared helper",
);
assert.doesNotMatch(
  publishRoute,
  /JSON\.parse\(revision\.payloadJson\)/,
  "the publish route never parses the persisted payload inline",
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
