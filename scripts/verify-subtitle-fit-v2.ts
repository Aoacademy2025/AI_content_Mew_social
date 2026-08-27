import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  renderSubtitle,
  resolveSubtitleFontSize,
  subtitleFitV2Enabled,
} from "../src/remotion/renderSubtitle";

function check(ok: unknown, message: string): asserts ok {
  assert.ok(ok, message);
  console.log(`✓ ${message}`);
}

function renderedFontSize(text: string): number {
  const markup = renderToStaticMarkup(renderSubtitle(
    text,
    "#FFFFFF",
    80,
    false,
    "plain",
    "Prompt, sans-serif",
    400,
    0,
    30,
    "fade",
  ));
  const match = markup.match(/font-size:([0-9]+)px/);
  assert.ok(match, `font size must be present in rendered markup for ${JSON.stringify(text)}`);
  return Number(match[1]);
}

const shortThaiCard = "พูดง่ายๆคือ";
const adjacentLongThaiCard = "AI กำลังออกจากช่วงลองเล่น";
const longestTicketCard = "และอาจแตะเกือบ 3. 2 พันล้านบาทในปีหน้า";

check(subtitleFitV2Enabled(undefined), "configured subtitle size is on by default after visual approval");
check(subtitleFitV2Enabled("1"), "the configured-size flag accepts explicit enablement");
check(!subtitleFitV2Enabled("0"), "the configured-size flag retains an emergency legacy rollback");

assert.equal(resolveSubtitleFontSize(shortThaiCard, 80, true), 80);
assert.equal(resolveSubtitleFontSize(adjacentLongThaiCard, 80, true), 80);
assert.equal(resolveSubtitleFontSize(longestTicketCard, 80, true), 80);
console.log("✓ adjacent cards from ticket #356 keep the configured 80px size");

assert.equal(resolveSubtitleFontSize("บรรทัดสั้น\nบรรทัดที่ยาวกว่ามาก", 80, true), 80);
console.log("✓ manual line breaks do not silently change the configured size");

assert.equal(resolveSubtitleFontSize(shortThaiCard, 80, false), 72);
assert.equal(resolveSubtitleFontSize(adjacentLongThaiCard, 80, false), 54);
assert.equal(resolveSubtitleFontSize(longestTicketCard, 80, false), 54);
console.log("✓ rollback mode preserves the exact legacy staircase");

const activeFitV2 = subtitleFitV2Enabled(process.env.NEXT_PUBLIC_SUBTITLE_FIT_V2);
assert.equal(renderedFontSize(shortThaiCard), resolveSubtitleFontSize(shortThaiCard, 80, activeFitV2));
assert.equal(
  renderedFontSize(adjacentLongThaiCard),
  resolveSubtitleFontSize(adjacentLongThaiCard, 80, activeFitV2),
);
assert.equal(
  renderedFontSize(longestTicketCard),
  resolveSubtitleFontSize(longestTicketCard, 80, activeFitV2),
);
console.log(`✓ renderSubtitle honors the active ${activeFitV2 ? "configured-size" : "rollback"} mode`);

const previewSource = readFileSync(
  "src/app/(dashboard)/video-editor/_components/subtitle-renderer.tsx",
  "utf8",
);
const burnSource = readFileSync("src/remotion/ShortVideoComposition.tsx", "utf8");
const renderRuntimeSource = readFileSync("src/lib/render/run-render.ts", "utf8");
check(
  previewSource.includes('import { renderSubtitle } from "@/remotion/renderSubtitle"')
    && previewSource.includes("return renderSubtitle("),
  "editor preview still delegates subtitle sizing to renderSubtitle",
);
check(
  burnSource.includes('import { renderSubtitle } from "./renderSubtitle"')
    && burnSource.includes("{renderSubtitle("),
  "Remotion burn still delegates subtitle sizing to the same renderSubtitle",
);
check(
  renderRuntimeSource.includes("NEXT_PUBLIC_SUBTITLE_FIT_V2")
    && (renderRuntimeSource.match(/envVariables:\s*remotionEnvVariables/g) ?? []).length >= 2,
  "render runtime propagates the same subtitle flag to composition selection and every burn page",
);

console.log("\n✅ SUBTITLE FIT V2 CHECKS PASSED");
