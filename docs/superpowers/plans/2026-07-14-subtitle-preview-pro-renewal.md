# Subtitle Preview Fidelity and PRO Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve complete subtitle text in paused/playback previews and let temporary or one-time PRO users without an active Stripe subscription buy or renew PRO.

**Architecture:** Keep subtitle behavior in the shared `renderSubtitle` renderer so preview and Remotion export stay aligned. Keep billing authorization in `checkoutAllowed`; add a pure paid-card presentation decision beside it and make Pricing consume that decision instead of equating `plan === PRO` with an active subscription.

**Tech Stack:** Next.js 15, React 19, TypeScript, React DOM server rendering, Prisma/SQLite, Stripe Checkout, `tsx` verification scripts.

## Global Constraints

- Do not modify legacy editor v1 navigation.
- Do not modify Stripe prices, checkout authorization, webhooks, trial duration, or plan duration.
- Do not add a database migration or entitlement-provenance field.
- Active Stripe subscribers must not be able to create a duplicate subscription.
- Paused Karaoke/Highlight must render exact source text at readable opacity.
- Playback/rendering must preserve punctuation, spaces, currency signs, percent signs, and manual line breaks exactly.
- Use a Red-Green TDD cycle for each behavior.

---

### Task 1: Preserve subtitle text in token effects

**Files:**
- Create: `scripts/verify-subtitle-render-text.ts`
- Modify: `src/remotion/renderSubtitle.tsx:52-121`
- Modify: `src/remotion/renderSubtitle.tsx:211-291`

**Interfaces:**
- Consumes: existing `renderSubtitle(...)` API.
- Produces: exact ordered token parts; only word parts consume animation indices; `frame < 0` renders static source text.

- [ ] **Step 1: Write the failing renderer verification**

Create `scripts/verify-subtitle-render-text.ts`:

```ts
import { renderToStaticMarkup } from "react-dom/server";
import { renderSubtitle } from "../src/remotion/renderSubtitle";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`✓ ${message}`);
}
function textContent(markup: string) { return markup.replace(/<[^>]*>/g, ""); }
function markup(text: string, effect: "karaoke" | "highlight", frame: number) {
  return renderToStaticMarkup(renderSubtitle(
    text, "#FFFFFF", 80, false, "shadow", "Kanit", 900,
    frame, 45, effect, "#F87171", { shadow: true },
  ));
}

const samples = ["ประมาณ 170,000 บาท", "ลด 50%", "ราคา ฿599", "บรรทัดแรก\nบรรทัดสอง"];
for (const effect of ["karaoke", "highlight"] as const) {
  for (const sample of samples) {
    const paused = markup(sample, effect, -1);
    assert(textContent(paused) === sample, `${effect} pause preserves ${JSON.stringify(sample)}`);
    assert(!paused.includes("#FFFFFF60"), `${effect} pause does not dim later tokens`);
    for (const frame of [0, 15, 44]) {
      assert(textContent(markup(sample, effect, frame)) === sample, `${effect} frame ${frame} preserves source text`);
    }
  }
}
assert(markup("หนึ่ง สอง", "karaoke", 0).includes("#F87171"), "karaoke playback retains active accent");
console.log("\n✅ SUBTITLE TEXT RENDER CHECKS PASSED");
```

- [ ] **Step 2: Run the check and verify RED**

Run: `npx tsx scripts/verify-subtitle-render-text.ts`

Expected: exit non-zero because current tokenization removes `,`; paused Karaoke also dims later tokens.

- [ ] **Step 3: Preserve exact text parts in tokenization**

Replace the word-only model in `renderSubtitle.tsx` with:

```ts
type TokenPart = { text: string; isWordLike: boolean };
type TokenLine = { parts: TokenPart[] };

function segmentParts(s: string): TokenPart[] {
  const seg = getSegmenter("th", "word");
  if (seg) {
    const parts = [...seg.segment(s)].map(({ segment, isWordLike }) => ({
      text: segment,
      isWordLike: isWordLike === true && segment.trim().length > 0,
    }));
    if (parts.length > 0) return parts;
  }
  const pieces = s.match(/\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]+/gu) ?? [];
  return pieces.map((text) => ({ text, isWordLike: /[\p{L}\p{N}]/u.test(text) }));
}
```

Build cached lines with `splitManualLines(text).map(line => ({ parts: segmentParts(line) }))`. Update `activeTokenIndex` to flatten only `part.isWordLike` parts and weight progress by `part.text.length`.

- [ ] **Step 4: Render pause and separators correctly**

For Highlight and Karaoke:

- If `frame < 0`, return the exact original `text` using the readable base style; retain Karaoke's `box`, `box-rounded`, and `karaoke-box` wrappers.
- During playback iterate `line.parts`. Render separator parts verbatim without incrementing `tokenIdx`; apply active/inactive styling only to word parts.
- Insert `<br />` only between manual lines.

The Karaoke loop must use this rule:

```tsx
if (!part.isWordLike) return <React.Fragment key={key}>{part.text}</React.Fragment>;
const currentIdx = tokenIdx++;
const isActive = currentIdx === active;
return <span key={key} style={{
  color: isActive ? accentColor : `${color}60`,
  fontWeight: isActive ? fontWeight : Math.min(fontWeight, 500),
}}>{part.text}</span>;
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx scripts/verify-subtitle-render-text.ts
npx tsx scripts/verify-tts-pause-timing.ts
```

Expected: both exit 0; the new script ends with `SUBTITLE TEXT RENDER CHECKS PASSED`.

- [ ] **Step 6: Commit Task 1**

```bash
git add scripts/verify-subtitle-render-text.ts src/remotion/renderSubtitle.tsx
git commit -m "fix: preserve subtitle text in karaoke preview"
```

---

### Task 2: Let non-subscription PRO users buy or renew PRO

**Files:**
- Modify: `scripts/verify-plan-change.ts`
- Modify: `src/lib/plan-change.ts:1-34`
- Modify: `src/app/(dashboard)/pricing/page.tsx:15`
- Modify: `src/app/(dashboard)/pricing/page.tsx:275-379`

**Interfaces:**
- Consumes: current plan, card plan, `subStatus`, and active-signup-trial state.
- Produces: `paidPlanCardMode(...)` returning `purchase | renew | current | manage | downgrade`.

- [ ] **Step 1: Add failing card-mode checks**

Import `paidPlanCardMode` in `scripts/verify-plan-change.ts` and append:

```ts
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: true }, "PRO") === "purchase", "signup-trial PRO stays purchasable");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: false }, "PRO") === "renew", "granted/one-time PRO can renew PRO");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: "active", isTrialPlan: false }, "PRO") === "current", "active PRO cannot duplicate PRO");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: "active", isTrialPlan: false }, "BUSINESS") === "manage", "active subscription changes via Billing");
assert(paidPlanCardMode({ currentPlan: "BUSINESS", subStatus: null, isTrialPlan: false }, "PRO") === "downgrade", "BUSINESS cannot pay to downgrade");
assert(paidPlanCardMode({ currentPlan: "PRO", subStatus: null, isTrialPlan: false }, "BUSINESS") === "purchase", "non-subscription PRO can upgrade");
```

- [ ] **Step 2: Run the check and verify RED**

Run: `npx tsx scripts/verify-plan-change.ts`

Expected: exit non-zero because `paidPlanCardMode` is not exported.

- [ ] **Step 3: Add the pure presentation decision**

Add to `src/lib/plan-change.ts`:

```ts
export type PaidPlanCardMode = "purchase" | "renew" | "current" | "manage" | "downgrade";
export function paidPlanCardMode(
  state: { currentPlan: string; subStatus: string | null; isTrialPlan: boolean },
  cardPlan: string,
): PaidPlanCardMode {
  if (state.isTrialPlan) return "purchase";
  if (cardPlan === state.currentPlan) {
    if (cardPlan === "PRO" && state.subStatus !== "active") return "renew";
    return "current";
  }
  if (state.subStatus === "active") return "manage";
  if ((PLAN_RANK[cardPlan] ?? 0) < (PLAN_RANK[state.currentPlan] ?? 0)) return "downgrade";
  return "purchase";
}
```

- [ ] **Step 4: Drive Pricing from the helper**

Replace the `PLAN_RANK` import in Pricing with `paidPlanCardMode`. For each paid card compute:

```ts
const cardMode = currentPlan && isPaid
  ? paidPlanCardMode({ currentPlan, subStatus: me?.subStatus ?? null, isTrialPlan }, key)
  : null;
const isCurrentTier = !!currentPlan && currentPlan === key && !isTrialPlan;
const isCurrent = cardMode === "current";
const isRenewCurrent = cardMode === "renew";
const isManageViaPortal = cardMode === "manage";
const isDowngradeLocked = cardMode === "downgrade";
```

Use `isCurrentTier` for the badge/outline, keep the disabled CTA only for `isCurrent`, and label the checkout button `ซื้อ / ต่ออายุ ${name}` when `isRenewCurrent`. Keep `handleUpgrade` and all payment routes unchanged.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx scripts/verify-plan-change.ts
npx tsx scripts/verify-pricing-display.ts
```

Expected: both exit 0 and the six new card-mode assertions pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/verify-plan-change.ts src/lib/plan-change.ts 'src/app/(dashboard)/pricing/page.tsx'
git commit -m "fix: allow temporary pro accounts to purchase pro"
```

---

### Task 3: Integrated verification and handoff

**Files:**
- Verify only; no expected production-file changes.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: fresh focused-test and production-build evidence.

- [ ] **Step 1: Run focused regression checks**

```bash
npx tsx scripts/verify-subtitle-render-text.ts
npx tsx scripts/verify-tts-pause-timing.ts
npx tsx scripts/verify-plan-change.ts
npx tsx scripts/verify-pricing-display.ts
```

Expected: all four commands exit 0.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: exit 0; no compile or build error is accepted.

- [ ] **Step 3: Review scope and worktree**

```bash
git diff --check HEAD~2..HEAD
git diff --stat HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors; only scoped renderer, verification, plan decision, and Pricing files changed. User-owned untracked files remain untouched.

- [ ] **Step 4: Report evidence and rollout boundary**

Report focused-test results, build result, commits, and confirmation that editor v1 navigation and payment backend were unchanged. Deployment and support-ticket writes remain separate unless explicitly requested.
