// verify-hero-112-motion-discovery.ts — HERO-112 verification:
// (1) Pure catalog helpers: MOTION_NEW_THEME_IDS, MOTION_FEATURED_THEME_IDS, isNewMotionTheme, featuredMotionThemes
// (2) Editor V2 discovery wiring in PostPhase.tsx, PostPhaseMobile.tsx, and BrollWindowInspector.tsx
//     including `ใหม่` badges, preselected theme + Motion tab launch, and `motion_broll_quick_cta_clicked` telemetry.
//
// Run: npx tsx scripts/verify-hero-112-motion-discovery.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MOTION_FEATURED_THEME_IDS,
  MOTION_NEW_THEME_IDS,
  MOTION_THEMES,
  featuredMotionThemes,
  isNewMotionTheme,
  motionTemplatesForTheme,
  planMotionSceneForWindow,
} from "../src/lib/motion-broll-catalog";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log("1. Catalog discovery helpers (motion-broll-catalog.ts)");

const expectedNewIds = ["paper-cutout-doc", "social-chat-sim", "apple-bento-glass"] as const;
const expectedFeaturedIds = [
  "paper-cutout-doc",
  "social-chat-sim",
  "apple-bento-glass",
  "doodle-explainer",
] as const;

check(
  "MOTION_NEW_THEME_IDS contains the 3 flagship styles",
  JSON.stringify(MOTION_NEW_THEME_IDS) === JSON.stringify(expectedNewIds),
);
check(
  "MOTION_FEATURED_THEME_IDS contains the 3 flagship styles + doodle-explainer",
  JSON.stringify(MOTION_FEATURED_THEME_IDS) === JSON.stringify(expectedFeaturedIds),
);

for (const id of expectedNewIds) {
  check(`isNewMotionTheme("${id}") === true`, isNewMotionTheme(id) === true);
}
for (const legacyId of ["doodle-explainer", "cue-step-board", "hyperframe-kinetic", "unknown", "", null, undefined]) {
  check(`isNewMotionTheme(${JSON.stringify(legacyId)}) === false`, isNewMotionTheme(legacyId) === false);
}

const featured = featuredMotionThemes();
check("featuredMotionThemes() returns 4 entries matching MOTION_FEATURED_THEME_IDS", featured.length === 4);
check(
  "featuredMotionThemes() preserves exact order and marks only the 3 flagship styles as isNew",
  featured.map((t) => t.id).join(",") === expectedFeaturedIds.join(",")
    && featured[0].isNew === true
    && featured[1].isNew === true
    && featured[2].isNew === true
    && featured[3].isNew === false,
);
check(
  "every featured theme has shortLabel, Thai tagline, 3-color palette, and templates in catalog",
  featured.every(
    (t) =>
      t.shortLabel.length > 0
      && /[ก-๙]/.test(t.tagline)
      && t.palette.length === 3
      && t.palette.every((hex) => /^#[0-9A-Fa-f]{6}$/.test(hex))
      && motionTemplatesForTheme(t.id).length > 0
      && MOTION_THEMES.some((entry) => entry.id === t.id),
  ),
);

for (const id of expectedFeaturedIds) {
  const planned = planMotionSceneForWindow({
    themeId: id,
    windowIndex: 0,
    totalWindows: 4,
    captionText: "ทำไมคลิปสั้นถึงดึงสายตาได้ตั้งแต่ 2 วินาทีแรก",
  });
  check(
    `planMotionSceneForWindow("${id}") plans a valid template for that theme`,
    planned.themeId === id && motionTemplatesForTheme(id).some((tpl) => tpl.id === planned.templateId),
  );
}

console.log("\n2. Editor V2 component wiring (PostPhase, PostPhaseMobile, BrollWindowInspector)");

const postPhaseSrc = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhase.tsx", "utf8");
const postPhaseMobileSrc = readFileSync("src/app/(dashboard)/video-editor/_v2/PostPhaseMobile.tsx", "utf8");
const inspectorSrc = readFileSync("src/app/(dashboard)/video-editor/_v2/BrollWindowInspector.tsx", "utf8");

check(
  "PostPhase.tsx imports featuredMotionThemes and renders Motion B-Roll กราฟิกขยับได้ (ใหม่) strip",
  postPhaseSrc.includes("featuredMotionThemes")
    && postPhaseSrc.includes("Motion B-Roll กราฟิกขยับได้ (ใหม่)")
    && postPhaseSrc.includes('data-motion-discovery-strip="post-phase"')
    && postPhaseSrc.includes("data-motion-quick-theme-id={theme.id}"),
);
check(
  "PostPhase.tsx gates Motion B-Roll strip on fullBrollEditEnabled && brollTimelineSpans.length > 0",
  postPhaseSrc.includes("const canQuickLaunchMotion = fullBrollEditEnabled && ed.brollTimelineSpans.length > 0;"),
);
check(
  "PostPhase.tsx renders ใหม่ badge for new motion themes and emits motion_broll_quick_cta_clicked with surface post-phase",
  postPhaseSrc.includes("theme.isNew")
    && postPhaseSrc.includes('data-motion-new-badge="true"')
    && postPhaseSrc.includes('trackEvent("motion_broll_quick_cta_clicked"')
    && postPhaseSrc.includes('surface: "post-phase"'),
);
check(
  "PostPhase.tsx wires initialTab, initialMotionThemeId, and initialMotionRequestKey into BrollWindowInspector",
  postPhaseSrc.includes('initialTab={motionLaunch ? "motion" : null}')
    && postPhaseSrc.includes("initialMotionThemeId={motionLaunch?.themeId ?? null}")
    && postPhaseSrc.includes("initialMotionRequestKey={motionLaunch?.requestKey ?? 0}"),
);

check(
  "PostPhaseMobile.tsx imports featuredMotionThemes and renders Motion B-Roll กราฟิกขยับได้ (ใหม่) strip",
  postPhaseMobileSrc.includes("featuredMotionThemes")
    && postPhaseMobileSrc.includes("Motion B-Roll กราฟิกขยับได้ (ใหม่)")
    && postPhaseMobileSrc.includes('data-motion-discovery-strip="post-phase-mobile"')
    && postPhaseMobileSrc.includes("data-motion-quick-theme-id={theme.id}"),
);
check(
  "PostPhaseMobile.tsx gates Motion B-Roll strip on fullBrollEditEnabled && brollSpans.length > 0",
  postPhaseMobileSrc.includes("const canQuickLaunchMotion = fullBrollEditEnabled && brollSpans.length > 0;"),
);
check(
  "PostPhaseMobile.tsx renders ใหม่ badge and emits motion_broll_quick_cta_clicked with surface post-phase-mobile",
  postPhaseMobileSrc.includes("theme.isNew")
    && postPhaseMobileSrc.includes('data-motion-new-badge="true"')
    && postPhaseMobileSrc.includes('trackEvent("motion_broll_quick_cta_clicked"')
    && postPhaseMobileSrc.includes('surface: "post-phase-mobile"'),
);
check(
  "PostPhaseMobile.tsx wires initialTab, initialMotionThemeId, and initialMotionRequestKey into BrollWindowInspector",
  postPhaseMobileSrc.includes('initialTab={motionLaunch ? "motion" : null}')
    && postPhaseMobileSrc.includes("initialMotionThemeId={motionLaunch?.themeId ?? null}")
    && postPhaseMobileSrc.includes("initialMotionRequestKey={motionLaunch?.requestKey ?? 0}"),
);

check(
  "BrollWindowInspector.tsx accepts initialTab, initialMotionThemeId, and initialMotionRequestKey",
  inspectorSrc.includes("initialTab?: BrollInspectorTab | null;")
    && inspectorSrc.includes("initialMotionThemeId?: MotionThemeId | null;")
    && inspectorSrc.includes("initialMotionRequestKey?: number;"),
);
check(
  "BrollWindowInspector.tsx syncs motionThemeFilter and Motion tab on launch and theme switches",
  inspectorSrc.includes("const forcedMotionTheme = fullBrollEditEnabled && initialMotionThemeId ? initialMotionThemeId : null;")
    && inspectorSrc.includes("setMotionThemeFilter(initialMotionThemeId);"),
);
check(
  "BrollWindowInspector.tsx renders ใหม่ badge via isNewMotionTheme(theme.id)",
  inspectorSrc.includes("isNewMotionTheme(theme.id)")
    && inspectorSrc.includes("data-motion-theme-id={theme.id}")
    && inspectorSrc.includes('data-motion-new-badge="true"')
    && /data-motion-new-badge="true"[\s\S]{0,1000}?>\s*ใหม่\s*<\/span>/u.test(inspectorSrc),
);

assert.equal(process.exitCode ?? 0, 0, "One or more HERO-112 checks failed");
console.log(`\nALL ${passed} HERO-112 MOTION DISCOVERY CHECKS PASSED`);
