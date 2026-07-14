// Run with: npx tsx scripts/verify-mobile-sheet.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as mobileSheet from "../src/lib/mobile-sheet";

const failures: string[] = [];

function check(name: string, run: () => void) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${detail}`);
    console.error(`not ok - ${name}\n  ${detail}`);
  }
}

function requireFunction<T extends (...args: never[]) => unknown>(
  name: string,
): T {
  const candidate = (mobileSheet as Record<string, unknown>)[name];
  assert.equal(typeof candidate, "function", `${name} implementation export is missing`);
  return candidate as T;
}

check("dismisses at the downward distance threshold", () => {
  const shouldDismiss = requireFunction<(motion: mobileSheet.SheetDragMotion) => boolean>(
    "shouldDismissSheetDrag",
  );
  assert.equal(shouldDismiss({ distanceY: 95.99, velocityY: 0.64 }), false);
  assert.equal(shouldDismiss({ distanceY: 96, velocityY: -0.2 }), true);
});

check("dismisses at the downward velocity threshold", () => {
  const shouldDismiss = requireFunction<(motion: mobileSheet.SheetDragMotion) => boolean>(
    "shouldDismissSheetDrag",
  );
  assert.equal(shouldDismiss({ distanceY: 12, velocityY: 0.649 }), false);
  assert.equal(shouldDismiss({ distanceY: 0, velocityY: 0.65 }), true);
});

check("never dismisses upward motion", () => {
  const shouldDismiss = requireFunction<(motion: mobileSheet.SheetDragMotion) => boolean>(
    "shouldDismissSheetDrag",
  );
  assert.equal(shouldDismiss({ distanceY: -120, velocityY: -0.8 }), false);
  assert.equal(shouldDismiss({ distanceY: -1, velocityY: 4 }), false);
});

check("clamps upward visual drag translation at zero", () => {
  const clampTranslation = requireFunction<(distanceY: number) => number>(
    "clampSheetDragTranslation",
  );
  assert.equal(clampTranslation(-48), 0);
  assert.equal(clampTranslation(0), 0);
  assert.equal(clampTranslation(42), 42);
});

check("drag release does not re-arm the one-time entrance animation", () => {
  const source = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/MobileSheet.tsx",
    "utf8",
  );
  assert.doesNotMatch(source, /animation:\s*dragging\s*\?/);
  assert.match(source, /sheetVisible\s*\?\s*["']translate3d\(0, 0, 0\)["']/);
});

check("pointer release samples velocity even without a final move event", () => {
  const source = readFileSync(
    "src/app/(dashboard)/video-editor/_v2/MobileSheet.tsx",
    "utf8",
  );
  assert.match(source, /const releaseVelocity\s*=\s*releaseElapsed\s*>\s*0/);
  assert.match(source, /velocityY:\s*releaseVelocity/);
});

if (failures.length > 0) {
  throw new Error(`mobile sheet verifier failed (${failures.length}):\n${failures.join("\n")}`);
}

console.log("mobile-sheet: all checks passed");
