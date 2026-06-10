# PromptPay payment option (pricing page) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose PromptPay (annual one-time, no auto-renew) vs card on the pricing page, closing Phase 1.

**Architecture:** Frontend-only change to `src/app/(dashboard)/pricing/page.tsx`. Add a `method` state and a second pill toggle that appears only for annual; pass `method` to the already-live `/api/payments/checkout` route (which resolves the PromptPay annual one-time price). No schema, route, or new component.

**Tech Stack:** Next.js 15 client component, React 19 `useState`, Tailwind, `cn()` helper (already imported in the file), `sonner` toast.

**Repo conventions:**
- Backend is DONE & LIVE: `resolvePrice(plan, period, method)` returns `annualOnetime` for `method:"promptpay"`; `/api/payments/checkout` sets `payment_method_types:["promptpay"]` + `mode:"payment"`. Do NOT change backend.
- No unit-test runner in this repo; verification = `npm run build` (CI gate) + chrome-devtools UI E2E (Stripe test mode). `package.json` is shared with wao1234 — do not add a test runner.
- `pricing/page.tsx` is Mew's vertical, not a shared file — low collision risk.

**Branch:** `mew/promptpay-ui` (already created off `main`).

**Business rules (from `resolvePrice`):** monthly → card only; annual → card (recurring) OR promptpay (one-time 365d). Applies to PRO + BUSINESS.

---

### Task 1: Add `method` state + wire it into checkout + reset on monthly

**Files:**
- Modify: `src/app/(dashboard)/pricing/page.tsx` (state ~line 50, `handleUpgrade` ~line 76, monthly button ~line 114)

- [ ] **Step 1: Add the `method` state**

Find (the existing period state, ~line 50):

```tsx
  const [period, setPeriod] = useState<"monthly" | "annual">("annual");
```

Add directly below it:

```tsx
  const [method, setMethod] = useState<"card" | "promptpay">("card");
```

- [ ] **Step 2: Send the selected method to checkout**

In `handleUpgrade`, find (~line 76):

```tsx
        body: JSON.stringify({ plan: planKey, period, method: "card" }),
```

Replace with:

```tsx
        body: JSON.stringify({ plan: planKey, period, method }),
```

- [ ] **Step 3: Reset method to card when switching to monthly**

Find the monthly toggle button (~line 114):

```tsx
          <button onClick={() => setPeriod("monthly")} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", period === "monthly" ? "bg-white/10 text-white" : "text-white/50")}>รายเดือน</button>
```

Replace the `onClick` only (keep className identical):

```tsx
          <button onClick={() => { setPeriod("monthly"); setMethod("card"); }} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", period === "monthly" ? "bg-white/10 text-white" : "text-white/50")}>รายเดือน</button>
```

- [ ] **Step 4: Typecheck via build**

Run: `npm run build`
Expected: build completes; `pricing/page.tsx` compiles, no TS error (method is typed and used).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/pricing/page.tsx"
git commit -m "feat(pricing): add payment method state + pass to checkout"
```

---

### Task 2: Render the PromptPay method toggle (annual only) + selection caption

**Files:**
- Modify: `src/app/(dashboard)/pricing/page.tsx` (insert after the period-toggle block, which currently ends ~line 117 with two closing `</div>` before the `{/* Payment result banner */}` comment)

- [ ] **Step 1: Insert the method toggle + caption**

Find the end of the period toggle block (~lines 112-117):

```tsx
      <div className="flex justify-center">
        <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
          <button onClick={() => { setPeriod("monthly"); setMethod("card"); }} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", period === "monthly" ? "bg-white/10 text-white" : "text-white/50")}>รายเดือน</button>
          <button onClick={() => setPeriod("annual")} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", period === "annual" ? "text-white" : "text-white/50")} style={period === "annual" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}>รายปี · ประหยัด 2 เดือน</button>
        </div>
      </div>
```

Immediately AFTER that closing `</div>` (the one that closes `flex justify-center`), insert:

```tsx
      {/* ── Payment method toggle (annual only) ─────────────────────── */}
      {period === "annual" && (
        <div className="flex justify-center">
          <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
            <button onClick={() => setMethod("card")} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", method === "card" ? "text-white" : "text-white/50")} style={method === "card" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}>💳 บัตร · ต่ออัตโนมัติ</button>
            <button onClick={() => setMethod("promptpay")} className={cn("px-5 py-2 rounded-full text-sm font-semibold transition", method === "promptpay" ? "text-white" : "text-white/50")} style={method === "promptpay" ? { background: "linear-gradient(135deg,#7c3aed,#06b6d4)" } : undefined}>📱 PromptPay · จ่ายครั้งเดียว</button>
          </div>
        </div>
      )}

      {/* ── Selection reassurance caption ───────────────────────────── */}
      <p className="text-center text-xs -mt-3" style={{ color: "var(--ui-text-muted)" }}>
        {period === "monthly"
          ? "ต่ออัตโนมัติทุกเดือน · ยกเลิกได้ทุกเมื่อ"
          : method === "promptpay"
            ? "จ่ายครั้งเดียว ไม่ตัดเงินอัตโนมัติ"
            : "ต่ออัตโนมัติทุกปี · ยกเลิกได้ทุกเมื่อ"}
      </p>
```

- [ ] **Step 2: Typecheck via build**

Run: `npm run build`
Expected: build completes; the page compiles with the conditional toggle + caption.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/pricing/page.tsx"
git commit -m "feat(pricing): PromptPay method toggle (annual) + selection caption"
```

---

### Task 3: Local E2E (chrome-devtools, Stripe test mode)

**Goal:** Prove the toggle behaves and the UI sends `method:"promptpay"` to checkout. No code changes — verification gate. Backend is already proven live.

**Prereqs:** Our app dev server running (e.g. `npx next dev -p 3005` — note `:3000` is a different project `content-deck`). Logged in as the Clerk test user `mewtest+clerk_test@example.com` (sign-in: email + password, then email 2FA code `424242`).

- [ ] **Step 1: Start dev server (if not running)**

Run: `cd "<repo>" && npx next dev -p 3005` (background)
Expected: responds 200 on `http://localhost:3005/`.

- [ ] **Step 2: Toggle visibility + reset (chrome-devtools)**

Navigate to `http://localhost:3005/pricing`, take a snapshot.
- Default period is annual → assert the method toggle (`💳 บัตร` / `📱 PromptPay`) is visible.
- Click `รายเดือน` → snapshot → assert the method toggle is GONE and caption reads `ต่ออัตโนมัติทุกเดือน · ยกเลิกได้ทุกเมื่อ`.
- Click `รายปี` then `📱 PromptPay · จ่ายครั้งเดียว` → snapshot → assert caption reads `จ่ายครั้งเดียว ไม่ตัดเงินอัตโนมัติ`.
- Click `รายเดือน` again → assert method reset (caption back to monthly text); switching to `รายปี` shows `💳 บัตร` active by default.

- [ ] **Step 3: Assert checkout payload uses promptpay**

With annual + PromptPay selected, click the PRO upgrade button. Before it redirects, capture the request via chrome-devtools `list_network_requests` / `get_network_request` for `POST /api/payments/checkout`.
Expected: request body contains `"method":"promptpay"` and `"period":"annual"`; response is `{ url: "https://checkout.stripe.com/..." }`.

- [ ] **Step 4: Confirm the Stripe session is a PromptPay one-time (test mode)**

From the returned `url`, extract the `cs_test_...` session id (or list recent sessions), and via the Stripe test API confirm `mode === "payment"` and `payment_method_types` includes `"promptpay"`.
Run (node, loads `.env` test key):

```js
const Stripe = require("stripe");
const s = new Stripe(process.env.STRIPE_SECRET_KEY);
s.checkout.sessions.list({ limit: 1 }).then(r => {
  const cs = r.data[0];
  console.log({ mode: cs.mode, methods: cs.payment_method_types });
  process.exit(0);
});
```
Expected: `{ mode: 'payment', methods: [ 'promptpay' ] }`.

- [ ] **Step 5: Card path still works**

Switch to annual + `💳 บัตร`, click upgrade, capture payload → `"method":"card"`; latest Stripe session `mode:"subscription"`. Confirms no regression.

- [ ] **Step 6: Record result**

If all pass, note in the PR. If any fail, STOP and debug (systematic-debugging) before shipping.

---

### Task 4: Ship — PR, CI, deploy

**Goal:** Merge + deploy. Frontend-only, no schema → standard deploy. **Gate: Mew's go + deploy timing aligned with wao1234.**

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin mew/promptpay-ui
gh pr create --base main --head mew/promptpay-ui --title "feat: PromptPay payment option on pricing page" --body "Adds an annual-only payment-method toggle (card vs PromptPay one-time) on the pricing page, passing method to the already-live checkout route. Frontend-only, no schema/route change. Closes Phase 1. Spec: docs/superpowers/specs/2026-06-05-promptpay-ui-design.md. Local E2E (Stripe test mode) passed."
```

- [ ] **Step 2: Confirm CI green**

Run: `gh pr checks <PR#>`
Expected: `Build` = `pass`.

- [ ] **Step 3: Merge**

After Mew's go: `gh pr merge <PR#> --merge --delete-branch`.

- [ ] **Step 4: Deploy (no db push needed — frontend only)**

On the VPS: `cd /var/www/ai-content && bash deploy/deploy.sh` (git pull + build + pm2 restart). No `prisma db push` (no schema change).

- [ ] **Step 5: Smoke-check prod**

`curl -s -o /dev/null -w "%{http_code}" https://studio.heroaiengine.com/pricing` → 200. Open `/pricing`, select annual → PromptPay → confirm checkout opens a PromptPay QR (real live = real money — just confirm the QR screen appears, then abandon; or trust the local test).

---

## Self-Review notes (completed by plan author)

- **Spec coverage:** method state + monthly reset + send method (Task 1) ✓; annual-only toggle + caption (Task 2) ✓; testing incl. toggle visibility/reset + checkout payload + card-no-regression (Task 3) ✓; deploy notes / frontend-only no-db-push (Task 4) ✓. Spec's "caption per card" simplified to one page-level caption under the toggle (same intent, less surface) — noted deviation.
- **No placeholders:** every code step has full code; commands have expected output.
- **Type consistency:** `method: "card" | "promptpay"` and `setMethod` used identically in state, monthly-reset, both toggle buttons, caption, and the checkout body across Tasks 1-2.
- **Known deviation from default TDD:** no unit-test runner (shared `package.json`); verification is the CI build gate + chrome-devtools E2E, matching the project's established pattern.
