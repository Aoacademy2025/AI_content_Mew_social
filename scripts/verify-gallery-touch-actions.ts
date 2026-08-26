/**
 * verify-gallery-touch-actions.ts — regression guard for #328.
 *
 * On phones the gallery's card actions used to live only in a `group-hover` overlay centred on the
 * card, so the first tap on iOS both revealed the overlay and fired the Download anchor underneath
 * (a 100 MB download instead of a preview). This static check keeps three invariants in
 * src/app/(dashboard)/videos/page.tsx:
 *   1. every hover-only overlay is desktop-scoped (`hidden … md:flex`), never visible-by-hover on touch;
 *   2. a touch action row (`md:hidden`) exists for both ProjectCard and VideoCard;
 *   3. the preview modal is viewport-capped (`min(100vw` + `dvh`) and the <video> has playsInline.
 * Run: npx tsx scripts/verify-gallery-touch-actions.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(__dirname, "../src/app/(dashboard)/videos/page.tsx");
const src = readFileSync(file, "utf8");
const failures: string[] = [];

const overlayLines = src.split("\n").filter((l) => l.includes("group-hover:opacity-100"));
for (const l of overlayLines) {
  if (!(l.includes(" hidden ") || l.includes("\"hidden ")) || !l.includes("md:flex")) {
    failures.push(`hover-only overlay not desktop-scoped: ${l.trim().slice(0, 100)}`);
  }
}
if (overlayLines.length < 2) failures.push("expected hover overlays for ProjectCard and VideoCard");

const touchRows = (src.match(/md:hidden"\n\s+onClick=\{e => e\.stopPropagation\(\)\}/g) ?? []).length;
if (touchRows < 2) failures.push(`expected 2 touch action rows (md:hidden + stopPropagation), found ${touchRows}`);

if (!src.includes('width: "min(100vw, calc(90dvh * 9 / 16))"')) failures.push("preview modal width is not viewport-capped");
if (!/<video[\s\S]{0,200}playsInline/.test(src.slice(src.indexOf("Preview modal")))) failures.push("preview <video> lacks playsInline");
if (/download=\{downloadFilename\}[^>]*target="_blank"/.test(src)) failures.push("download anchor still uses target=_blank (iOS popup block)");

if (failures.length) {
  console.error("verify-gallery-touch-actions: FAIL");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("verify-gallery-touch-actions: ok (overlays desktop-scoped, touch rows present, modal capped, playsInline)");
