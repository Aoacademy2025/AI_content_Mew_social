import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeHexColor } from "../src/lib/hex-color";

assert.equal(normalizeHexColor("#d29d00"), "#D29D00");
assert.equal(normalizeHexColor("ffd479"), "#FFD479");
assert.equal(normalizeHexColor("#abc"), "#AABBCC");
assert.equal(normalizeHexColor("rgb(255, 0, 0)"), null);
assert.equal(normalizeHexColor("#12GG00"), null);

const advanced = readFileSync("src/app/(dashboard)/brands/_components/AdvancedSettings.tsx", "utf8");
const brandList = readFileSync("src/app/(dashboard)/brands/_components/BrandList.tsx", "utf8");
const brandClient = readFileSync("src/app/(dashboard)/brands/_components/BrandLibraryClient.tsx", "utf8");
const postPhase = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
const libraryRoute = readFileSync("src/app/api/brand-library/route.ts", "utf8");
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
assert.match(previewServer, /where:\s*\{\s*id:\s*input\.profileId,\s*userId:\s*input\.userId,\s*archivedAt:\s*null\s*\}/,
  "archived Brands cannot start a new preview");
assert.match(heroScriptServer, /where:\s*\{\s*id:\s*brandProfileId,\s*userId,\s*archivedAt:\s*null\s*\}/,
  "archived Brands cannot seed new Hero Script work");
assert.match(schema, /archivedAt\s+DateTime\?/, "Brand Profile stores a recoverable archive timestamp");

console.log("Brand Library support-feature contracts passed");
