// Run: npx tsx scripts/verify-avatar-layout-geometry.ts
// Locks the avatar-layout geometry that BOTH the ffmpeg composite and the editor preview depend on.
import { clampAvatarLayout, layoutGeometry, normalizedBox, CANVAS_W, CANVAS_H } from "../src/lib/avatar-layout";

let p = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); p++; };

// geometry: scale 1 + no offset = full canvas at origin
const g1 = layoutGeometry({ scale: 1, offsetX: 0, offsetY: 0 });
ok(g1.w === CANVAS_W && g1.h === CANVAS_H && g1.x === 0 && g1.y === 0, "scale 1 / no offset → full canvas at (0,0)");

// geometry: scale 0.5 centered
const g2 = layoutGeometry({ scale: 0.5, offsetX: 0, offsetY: 0 });
ok(g2.w === 540 && g2.h === 960 && g2.x === 270 && g2.y === 480, "scale 0.5 → 540x960 centered at (270,480)");

// geometry: offsetX 400 shifts a full canvas right by CANVAS_W
const g3 = layoutGeometry({ scale: 1, offsetX: 400, offsetY: 0 });
ok(g3.x === CANVAS_W && g3.y === 0, "offsetX 400 → x shifted by +1080 (full frame right)");

// normalizedBox: editor uses center-based percentages
const b = normalizedBox({ scale: 0.5, offsetX: 200, offsetY: -200 });
ok(b.widthPct === 50 && b.heightPct === 50, "normalizedBox scale 0.5 → 50% w/h");
ok(b.centerXPct === 100 && b.centerYPct === 0, "normalizedBox offset (200,-200) → center (100%,0%)");

// clamp: no-op (scale~1, offset~0) returns null so composite falls back to full-cover
ok(clampAvatarLayout({ scale: 1, offsetX: 0, offsetY: 0 }) === null, "no-op layout clamps to null (full-cover fallback)");
// clamp: bounds
const c = clampAvatarLayout({ scale: 99, offsetX: 9999, offsetY: -9999 });
ok(!!c && c.scale === 4 && c.offsetX === 400 && c.offsetY === -400, "clamp bounds scale≤4, |offset|≤400");
// clamp: garbage → null
ok(clampAvatarLayout({ scale: "x" }) === null && clampAvatarLayout(null) === null, "non-finite/garbage → null");

console.log(`\n✅ ALL ${p} AVATAR-LAYOUT GEOMETRY CHECKS PASSED`);
