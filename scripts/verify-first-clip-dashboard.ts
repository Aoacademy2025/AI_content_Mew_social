// Unit tests for the First-Clip day-one dashboard (#304, #305).
// Run: npx tsx scripts/verify-first-clip-dashboard.ts
//
// Covers the three rules the dashboard, the sidebar CTA and the quota chip all
// share: which stepper state an account is in, the "≈ N คลิปสั้น" arithmetic,
// and the low-quota threshold that used to light up amber on a trial's very
// first visit (remaining <= 10 minutes).

import {
  approxShortClips,
  deriveFirstClipState,
  firstClipStepIndex,
  isLowQuota,
  LOW_QUOTA_RATIO,
  shouldShowFirstClipHero,
  summarizeFirstClipProgress,
  type FirstClipState,
} from "../src/lib/first-clip-dashboard";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

// ── state derivation ────────────────────────────────────────────────────────
const fresh = { hasExport: false, renderedClip: false, activeRender: false };

check(
  "brand-new account is on step 1",
  deriveFirstClipState(fresh) === "no_script",
);
check(
  "a render in flight is step 2",
  deriveFirstClipState({ ...fresh, activeRender: true }) === "rendering",
);
check(
  "a finished render with no export is step 3",
  deriveFirstClipState({ ...fresh, renderedClip: true }) === "rendered_not_exported",
);
check(
  "an export ends the journey",
  deriveFirstClipState({ ...fresh, renderedClip: true, activeRender: true, hasExport: true }) === "exported",
);
check(
  "furthest progress wins: rendered clip outranks a second render in flight",
  deriveFirstClipState({ ...fresh, renderedClip: true, activeRender: true }) === "rendered_not_exported",
);

const stepIndex: Record<FirstClipState, number> = {
  no_script: 1,
  rendering: 2,
  rendered_not_exported: 3,
  exported: 3,
};
for (const [state, expected] of Object.entries(stepIndex) as [FirstClipState, number][]) {
  check(
    `step index for ${state} is ${expected}`,
    firstClipStepIndex(state) === expected,
    `got ${firstClipStepIndex(state)}`,
  );
}

// ── project-status summarisation (server input) ─────────────────────────────
check(
  "draft-only projects show no progress",
  (() => {
    const p = summarizeFirstClipProgress(["draft", "draft"]);
    return !p.activeRender && !p.renderedClip;
  })(),
);
check(
  "a rendering project is an active render",
  (() => {
    const p = summarizeFirstClipProgress(["rendering"]);
    return p.activeRender && !p.renderedClip;
  })(),
);
check(
  "post / exporting / exported all count as a rendered clip",
  ["post", "exporting", "exported"].every((status) => summarizeFirstClipProgress([status]).renderedClip),
);
check(
  "unknown statuses are ignored (fail-safe: stays on step 1)",
  (() => {
    const p = summarizeFirstClipProgress(["archived", "something-new"]);
    return !p.activeRender && !p.renderedClip;
  })(),
);

// ── who sees the hero ───────────────────────────────────────────────────────
check(
  "an account on the path before its first export sees the hero",
  shouldShowFirstClipHero({ onPath: true, state: "no_script" })
  && shouldShowFirstClipHero({ onPath: true, state: "rendering" })
  && shouldShowFirstClipHero({ onPath: true, state: "rendered_not_exported" }),
);
check(
  "an exported account falls back to today's dashboard",
  !shouldShowFirstClipHero({ onPath: false, state: "exported" }),
);
check(
  "FREE / internal accounts (off the path) never see the hero",
  !shouldShowFirstClipHero({ onPath: false, state: "no_script" }),
);

// ── ≈ clips arithmetic ──────────────────────────────────────────────────────
check("15 trial minutes ≈ 5 short clips", approxShortClips(15) === 5);
check("80 PRO minutes ≈ 26 short clips", approxShortClips(80) === 26);
check("5 FREE minutes ≈ 1 short clip", approxShortClips(5) === 1);
check("2 minutes rounds down to 0 clips", approxShortClips(2) === 0);
check("0 minutes is 0 clips", approxShortClips(0) === 0);
check("a negative balance never shows a negative clip count", approxShortClips(-4) === 0);
check("a non-finite balance is 0, not NaN", approxShortClips(Number.NaN) === 0);

// ── low-quota threshold (#304) ──────────────────────────────────────────────
check("threshold is 20% of the plan's own allowance", LOW_QUOTA_RATIO === 0.2);
check(
  "a full 15-minute trial is NOT low (the old <=10 rule flagged it on day one)",
  !isLowQuota(15, 15),
);
check("11 of 15 trial minutes left is not low", !isLowQuota(11, 15));
check("3 of 15 trial minutes left is low", isLowQuota(3, 15));
check("exactly 20% is low", isLowQuota(16, 80));
check("just above 20% is not low", isLowQuota(17, 80) === false);
check("8 of 80 PRO minutes left is low", isLowQuota(8, 80));
check("a zero/unknown limit never warns", !isLowQuota(0, 0));
check("a non-finite limit never warns", !isLowQuota(5, Number.NaN));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nverify-first-clip-dashboard: PASS");
