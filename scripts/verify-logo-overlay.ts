import assert from "node:assert/strict";

import {
  DEFAULT_LOGO_OPACITY,
  DEFAULT_LOGO_POSITION,
  DEFAULT_LOGO_SIZE_PCT,
  LOGO_POSITIONS,
  MAX_LOGO_OPACITY,
  MAX_LOGO_SIZE_PCT,
  MIN_LOGO_OPACITY,
  MIN_LOGO_SIZE_PCT,
  logoOverlayFrame,
  normalizeLogoOverlayConfig,
  type LogoFrame,
  type LogoPosition,
} from "@/lib/logo-overlay";

const closeTo = (actual: number, expected: number, message: string) => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, received ${actual}`,
  );
};

assert.deepEqual(LOGO_POSITIONS, [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);
assert.equal(DEFAULT_LOGO_POSITION, "top-right");
assert.equal(DEFAULT_LOGO_SIZE_PCT, 18);
assert.equal(DEFAULT_LOGO_OPACITY, 0.9);
assert.equal(MIN_LOGO_SIZE_PCT, 8);
assert.equal(MAX_LOGO_SIZE_PCT, 35);
assert.equal(MIN_LOGO_OPACITY, 0.2);
assert.equal(MAX_LOGO_OPACITY, 1);

assert.deepEqual(
  normalizeLogoOverlayConfig({ enabled: true, assetId: "brand-logo" }),
  {
    enabled: true,
    assetId: "brand-logo",
    position: DEFAULT_LOGO_POSITION,
    sizePct: DEFAULT_LOGO_SIZE_PCT,
    opacity: DEFAULT_LOGO_OPACITY,
  },
);
assert.equal(normalizeLogoOverlayConfig({ enabled: true, assetId: "   " }), null);
assert.equal(normalizeLogoOverlayConfig({ enabled: true, assetId: 42 }), null);
assert.equal(normalizeLogoOverlayConfig(null), null);

assert.deepEqual(
  normalizeLogoOverlayConfig({
    enabled: false,
    assetId: "  brand-logo  ",
    position: "somewhere-else",
    sizePct: 1,
    opacity: 9,
  }),
  {
    enabled: false,
    assetId: "brand-logo",
    position: DEFAULT_LOGO_POSITION,
    sizePct: MIN_LOGO_SIZE_PCT,
    opacity: MAX_LOGO_OPACITY,
  },
);
assert.deepEqual(
  normalizeLogoOverlayConfig({
    enabled: true,
    assetId: "brand-logo",
    position: "bottom-left",
    sizePct: 99,
    opacity: -1,
  }),
  {
    enabled: true,
    assetId: "brand-logo",
    position: "bottom-left",
    sizePct: MAX_LOGO_SIZE_PCT,
    opacity: MIN_LOGO_OPACITY,
  },
);
assert.deepEqual(
  normalizeLogoOverlayConfig({
    assetId: "brand-logo",
    sizePct: Number.NaN,
    opacity: Number.POSITIVE_INFINITY,
  }),
  {
    enabled: true,
    assetId: "brand-logo",
    position: DEFAULT_LOGO_POSITION,
    sizePct: DEFAULT_LOGO_SIZE_PCT,
    opacity: DEFAULT_LOGO_OPACITY,
  },
);

const frameWidth = 1080;
const frameHeight = 1920;
const inset = 43.2;
const logoSize = 194.4;
const expectedAnchors: Record<LogoPosition, Pick<LogoFrame, "left" | "top">> = {
  "top-left": { left: inset, top: inset },
  "top-center": { left: 442.8, top: inset },
  "top-right": { left: 842.4, top: inset },
  "middle-left": { left: inset, top: 862.8 },
  center: { left: 442.8, top: 862.8 },
  "middle-right": { left: 842.4, top: 862.8 },
  "bottom-left": { left: inset, top: 1682.4 },
  "bottom-center": { left: 442.8, top: 1682.4 },
  "bottom-right": { left: 842.4, top: 1682.4 },
};

for (const position of LOGO_POSITIONS) {
  const frame = logoOverlayFrame({
    position,
    sizePct: DEFAULT_LOGO_SIZE_PCT,
    intrinsic: { width: 100, height: 100 },
    frameWidth,
    frameHeight,
  });
  const expected = expectedAnchors[position];

  closeTo(frame.left, expected.left, `${position} left`);
  closeTo(frame.top, expected.top, `${position} top`);
  closeTo(frame.width, logoSize, `${position} width`);
  closeTo(frame.height, logoSize, `${position} height`);
  assert.ok(frame.left >= inset, `${position} clears the left safe inset`);
  assert.ok(frame.top >= inset, `${position} clears the top safe inset`);
  assert.ok(
    frame.left + frame.width <= frameWidth - inset + 1e-9,
    `${position} clears the right safe inset`,
  );
  assert.ok(
    frame.top + frame.height <= frameHeight - inset + 1e-9,
    `${position} clears the bottom safe inset`,
  );
}

const aspectCases = [
  { name: "wide", intrinsic: { width: 400, height: 100 } },
  { name: "square", intrinsic: { width: 100, height: 100 } },
  { name: "tall", intrinsic: { width: 100, height: 4000 } },
] as const;

for (const { name, intrinsic } of aspectCases) {
  const frame = logoOverlayFrame({
    position: "center",
    sizePct: DEFAULT_LOGO_SIZE_PCT,
    intrinsic,
    frameWidth,
    frameHeight,
  });

  closeTo(
    frame.width / frame.height,
    intrinsic.width / intrinsic.height,
    `${name} aspect ratio`,
  );
  assert.ok(frame.left >= inset, `${name} clears the left safe inset`);
  assert.ok(frame.top >= inset, `${name} clears the top safe inset`);
  assert.ok(
    frame.left + frame.width <= frameWidth - inset + 1e-9,
    `${name} clears the right safe inset`,
  );
  assert.ok(
    frame.top + frame.height <= frameHeight - inset + 1e-9,
    `${name} clears the bottom safe inset`,
  );
}

const tallFrame = logoOverlayFrame({
  position: "bottom-right",
  sizePct: DEFAULT_LOGO_SIZE_PCT,
  intrinsic: { width: 100, height: 4000 },
  frameWidth,
  frameHeight,
});
closeTo(tallFrame.height, frameHeight - inset * 2, "tall logo fitted height");
closeTo(tallFrame.top, inset, "tall logo fitted bottom anchor");
closeTo(
  tallFrame.left + tallFrame.width,
  frameWidth - inset,
  "tall logo fitted right anchor",
);

console.log("logo-overlay: all checks passed");
