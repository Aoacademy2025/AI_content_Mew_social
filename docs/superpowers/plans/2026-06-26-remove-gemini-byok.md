# Remove Gemini BYOK (managed-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When `MANAGED_GEMINI=1`, Gemini is fully server-managed — users never supply, are never asked for, and never have resolved-from their own Gemini key. ElevenLabs/HeyGen/Pexels/Pixabay BYOK stays. Flag-off = today's BYOK verbatim.

**Architecture:** One core resolver flip (managed-first) + `MANAGED_GEMINI`-gated hiding of every Gemini-key surface (Settings input, onboarding wizard/checklist, docs, MCP onboarding, save/test handlers, error messaging). Server surfaces read `process.env.MANAGED_GEMINI === "1"` directly; client surfaces read a new `managed` boolean returned by the existing `GET /api/user/api-keys/status` (no new client flag → no extra go-live coupling).

**Tech Stack:** Next.js 15 App Router, Prisma 6. Existing: `src/lib/gemini-key.ts`, `src/lib/key-tiers.ts`, `src/lib/gemini-errors.ts`, `src/lib/mcp/onboarding.ts`.

## Global Constraints

- **Flag-off byte-identical (HARD):** with `MANAGED_GEMINI` unset, every surface behaves exactly as today (BYOK input shown, Gemini required, user key resolved, "fix your key" errors). Every change is gated on `process.env.MANAGED_GEMINI === "1"` (server) or the `managed` field from the status route (client).
- **Managed-first resolution:** when managed, `resolveGeminiKey` returns the server key and IGNORES any stored `user.geminiKey` (this is what actually removes BYOK for the ~76 existing key-holders). Stored keys are LEFT in place (not cleared) — managed simply ignores them; reversible.
- **Keep** ElevenLabs/HeyGen/Pexels/Pixabay BYOK inputs + flows untouched.
- **Scope = functional/structural removal** (resolution, required-status, input hidden, errors, save/test, MCP requirement). Pure copy rewording beyond Gemini-removal (clip→minutes, marketing "ใส่ key ฟรี") is piece (3) copy-sweep — NOT here. (Ships together at go-live.)
- **Couples with the new model at go-live:** `MANAGED_GEMINI=1` + `GEMINI_SERVER_KEY` set, deployed together with the keystone + copy-sweep.
- Build on `mew/managed-path-ux` (HEAD 97973f4). NOT pushed/merged/deployed (Mew deploys). Implementers must NOT `git add` `.superpowers/` scratch.

## Already managed-aware (from piece #1 — DO NOT re-touch)
`computeKeyStatus(present, isManagedMode)` (key-tiers.ts:88-95, `gemini := present.gemini || isManagedMode`); `GET /api/user/api-keys/status` passes `isManagedMode` (status route:22-26); `mcp/tools.ts:16` (`gemini := !!user.geminiKey || MANAGED_GEMINI`); `fetch-stock:1307` (try/catch around resolveGeminiKey, falls through). These stay.

## File Structure

| File | Change | Task |
|---|---|---|
| `src/lib/gemini-key.ts` | `resolveGeminiKey`: managed-first when `MANAGED_GEMINI=1` | 1 |
| `scripts/verify-gemini-managed.ts` (NEW) | TDD the resolver + (T3) tiers | 1,3 |
| `src/app/api/user/api-keys/status/route.ts` | add `managed: boolean` to the response | 2 |
| `src/lib/key-tiers.ts` | `requiredKeysFor(managed)` excludes Gemini when managed; keep `computeKeyStatus`/`isTier1Complete` | 2 |
| `src/lib/gemini-errors.ts` | managed-aware messaging (platform issue, not "fix your key") | 3 |
| `src/lib/gemini.ts` | pass managed into the error path (caller of getGeminiErrorInfo) | 3 |
| `src/components/settings/api-key-settings.tsx` | hide the Gemini field when `managed` | 4 |
| `src/components/onboarding/KeyOnboardingWizard.tsx` | exclude Gemini from required when `managed` | 4 |
| `src/components/onboarding/KeySetupChecklist.tsx` | hide the Gemini row when `managed` | 4 |
| `src/app/(dashboard)/docs/page.tsx` | hide the Gemini BYOK setup section when managed | 4 |
| `src/app/api/user/api-keys/route.ts` | PUT: ignore `geminiKey` writes when managed | 5 |
| `src/app/api/user/test-key/route.ts` | Gemini test → auto-pass/skip when managed | 5 |
| `src/lib/mcp/onboarding.ts` | `buildSetupGuide`/`missingKeyError`/SERVER_INSTRUCTIONS: Gemini not required when managed | 5 |

---

### Task 1: resolveGeminiKey managed-first (CORE)

**Why:** The actual "BYOK removed" — when managed, ignore any stored user key and use the server key, so the ~76 existing key-holders move to managed automatically.

**Files:** Modify `src/lib/gemini-key.ts:5-15`; Create `scripts/verify-gemini-managed.ts`.

**Interfaces:** Produces `resolveGeminiKey(user:{geminiKey:string|null;plan:string}): {key:string; mode:"managed"|"byok"}` (unchanged signature; throws `KeyRequiredError("gemini")` when neither available).

- [ ] **Step 1: Write failing tests** — `scripts/verify-gemini-managed.ts`:
```ts
// managed on + server key → managed, IGNORES a stored user key
process.env.MANAGED_GEMINI = "1"; process.env.GEMINI_SERVER_KEY = "SRV";
let r = resolveGeminiKey({ geminiKey: Buffer.from("USERKEY").toString("base64"), plan: "PRO" });
assert(r.mode === "managed" && r.key === "SRV", "managed-first ignores stored user key");
// managed on + NO server key → falls back to user key if present
delete process.env.GEMINI_SERVER_KEY;
r = resolveGeminiKey({ geminiKey: Buffer.from("USERKEY").toString("base64"), plan: "PRO" });
assert(r.mode === "byok" && r.key === "USERKEY", "managed w/o server key falls back to user key");
// managed OFF → user key (byte-identical to today)
process.env.MANAGED_GEMINI = "0"; process.env.GEMINI_SERVER_KEY = "SRV";
r = resolveGeminiKey({ geminiKey: Buffer.from("USERKEY").toString("base64"), plan: "PRO" });
assert(r.mode === "byok" && r.key === "USERKEY", "flag off → BYOK verbatim");
// off + no user key → throw KeyRequiredError
let threw = false; try { resolveGeminiKey({ geminiKey: null, plan: "PRO" }); } catch (e) { threw = (e as Error).name === "KeyRequiredError" || /gemini/i.test((e as Error).message); }
assert(threw, "off + no key → KeyRequiredError");
```

- [ ] **Step 2: Run → fails** (managed-first not implemented). `npx tsx scripts/verify-gemini-managed.ts`

- [ ] **Step 3: Flip the priority** — `src/lib/gemini-key.ts`:
```ts
export function resolveGeminiKey(user: { geminiKey: string | null; plan: string }): { key: string; mode: "managed" | "byok" } {
  const managed = process.env.MANAGED_GEMINI === "1";
  const serverKey = process.env.GEMINI_SERVER_KEY ?? "";
  // Managed-first: when managed mode is on and a server key is configured, always
  // use it and IGNORE any stored user key (Gemini BYOK is removed in managed mode).
  if (managed && serverKey) return { key: serverKey, mode: "managed" };
  // Flag off (or managed but server key missing) → legacy BYOK, byte-identical to before.
  if (user.geminiKey && user.geminiKey.trim()) {
    const decoded = Buffer.from(user.geminiKey.trim(), "base64").toString("utf-8");
    return { key: decoded, mode: "byok" };
  }
  throw new KeyRequiredError("gemini");
}
```

- [ ] **Step 4: Run → passes.** `npx tsx scripts/verify-gemini-managed.ts` → ALL PASS. `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit** — `git add src/lib/gemini-key.ts scripts/verify-gemini-managed.ts` → `git commit -m "feat(managed): resolveGeminiKey managed-first — ignore stored user key when MANAGED_GEMINI"`

---

### Task 2: status `managed` field + key-tiers required-keys helper

**Why:** Client surfaces need to know "are we managed" (without a new client flag) → expose it from the status route. And Gemini must drop out of the REQUIRED key set when managed (the wizard renders from it).

**Files:** Modify `src/app/api/user/api-keys/status/route.ts`; `src/lib/key-tiers.ts`; extend `scripts/verify-gemini-managed.ts`.

**Interfaces:** Produces: status JSON gains `managed: boolean`; `requiredKeysFor(managed: boolean): KeyDef[]` (REQUIRED_KEYS minus Gemini when managed). `isTier1Complete`/`computeKeyStatus` UNCHANGED (already managed-aware).

- [ ] **Step 1: Test** (append to verify-gemini-managed.ts): `requiredKeysFor(true)` excludes the `gemini` id; `requiredKeysFor(false)` includes it; both include pexels/pixabay.
```ts
assert(!requiredKeysFor(true).some(k => k.id === "gemini"), "managed → gemini not required");
assert(requiredKeysFor(false).some(k => k.id === "gemini"), "off → gemini required");
assert(requiredKeysFor(true).some(k => k.id === "pexels"), "managed keeps pexels required");
```

- [ ] **Step 2: Run → fails** (requiredKeysFor not defined).

- [ ] **Step 3: Implement** —
  - `key-tiers.ts`: add `export function requiredKeysFor(managed: boolean) { return REQUIRED_KEYS.filter(k => !(managed && k.id === "gemini")); }` (keep `REQUIRED_KEYS` as-is for flag-off).
  - status route: add `managed: process.env.MANAGED_GEMINI === "1"` to the returned JSON (additive field; harmless when false — but to keep flag-off byte-identical, add it ALWAYS as a boolean since the client only ACTS on `true`; an always-present `managed:false` is benign and read only by new client code). If strict byte-identical is required, gate it: `...(process.env.MANAGED_GEMINI === "1" ? { managed: true } : {})`. **Use the gated form** for consistency with the project's byte-identical bar.

- [ ] **Step 4: Run → passes.** tsc 0.

- [ ] **Step 5: Commit** — `feat(managed): status exposes managed + requiredKeysFor excludes gemini when managed`

---

### Task 3: gemini-errors managed-aware

**Why:** When managed, a Gemini failure is a platform problem, not the user's key. Stop telling managed users to "create a new key / bind billing".

**Files:** Modify `src/lib/gemini-errors.ts`; `src/lib/gemini.ts` (the caller). Extend the verify script if the messaging is pure-function testable.

**Interfaces:** `getGeminiErrorInfo(err, opts?: { managed?: boolean })` — when `managed`, user-facing messages become a generic platform message; the error KIND/telemetry stays the same.

- [ ] **Step 1: Test** — managed=true → the `invalid_key`/`billing`/`quota` user messages do NOT contain "key ใหม่"/"ผูกบัตร"/"Settings"; instead a platform message ("ระบบ AI ขัดข้องชั่วคราว ลองใหม่ หรือแจ้งทีมงาน"). managed=false → today's messages verbatim.

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement** — add an optional `managed` arg; when true, return a single platform-framed `userMessage` for the user-key-fault kinds (`invalid_key`, `billing`, `permission`, `api_disabled`) while keeping transient kinds (`quota`/`high_demand`/`timeout`) as-is (those are真 platform/transient). Thread `managed: process.env.MANAGED_GEMINI === "1"` from `gemini.ts:43`. Default `managed=false` → byte-identical.

- [ ] **Step 4: Run → passes.** tsc 0.

- [ ] **Step 5: Commit** — `feat(managed): gemini-errors platform-framed messaging when managed`

---

### Task 4: Client UI — hide Gemini surfaces when managed

**Why:** Stop showing/requiring the Gemini key input + setup steps to managed users.

**Files:** `src/components/settings/api-key-settings.tsx`; `src/components/onboarding/KeyOnboardingWizard.tsx`; `src/components/onboarding/KeySetupChecklist.tsx`; `src/app/(dashboard)/docs/page.tsx`.

**Interfaces:** Consumes `managed` from `GET /api/user/api-keys/status` (Task 2). Each surface already fetches that status (or can) — read `managed` and conditionally drop the Gemini bits.

**Flag-off requirement:** when `managed` is absent/false, every surface renders exactly as today (Gemini field shown, row shown, docs section shown, wizard requires Gemini).

- [ ] **Step 1: api-key-settings.tsx** — where it renders `field("gemini")` (~line 201, under the "จำเป็น" header), wrap so it renders only when `!managed`. Keep pexels/pixabay/advanced as-is. (Source `managed` from the status fetch this component already does; if it doesn't fetch status, add a lightweight fetch or thread a prop.)
- [ ] **Step 2: KeyOnboardingWizard.tsx** — replace the `REQUIRED_KEYS.map(...)` (~line 89) with `requiredKeysFor(managed).map(...)` so Gemini drops out when managed (and the Google AI Studio link block at ~115-117 hides with it).
- [ ] **Step 3: KeySetupChecklist.tsx** — the Gemini `<Row done={status.gemini} label="Gemini key (จำเป็น)" />` (~line 33): render only when `!status.managed`. (When managed, `status.gemini` is already true via computeKeyStatus, but we hide the row entirely rather than show a satisfied user-key row.)
- [ ] **Step 4: docs/page.tsx** — wrap the Gemini-key setup steps (the "ขั้นตอนที่ต้องทำก่อนใช้งาน Gemini Key" heading + AI Studio/Cloud links ~456-458 + the required `ApiRow name="Gemini API Key"` ~470) so they render only when `!managed`. Leave the Voice/troubleshooting mentions for piece (3) copy-sweep (they're informational, not BYOK-setup). Source `managed` (docs page is a client/server component — if server, read `process.env.MANAGED_GEMINI`; if client, fetch status).
- [ ] **Step 5: Verify** — `npx tsc --noEmit` → 0. State the flag-off proof (every Gemini-hide is `!managed`-gated; managed defaults false ⇒ shown). Screenshots blocked → Mew views live after merge.
- [ ] **Step 6: Commit** — `feat(managed): hide Gemini key input/onboarding/docs when managed (client)`

---

### Task 5: Server handlers — save/test/MCP managed-aware

**Why:** Don't accept, test, or require a Gemini key server-side when managed.

**Files:** `src/app/api/user/api-keys/route.ts` (PUT); `src/app/api/user/test-key/route.ts`; `src/lib/mcp/onboarding.ts`.

- [ ] **Step 1: api-keys PUT** (~line 45) — when `process.env.MANAGED_GEMINI === "1"`, ignore inbound `geminiKey` (do not write it): `if (geminiKey !== undefined && process.env.MANAGED_GEMINI !== "1") updateData.geminiKey = geminiKey ? encrypt(geminiKey) : null;`. (Leaves existing stored keys untouched; just stops accepting new ones when managed.) Other keys unchanged.
- [ ] **Step 2: test-key route** (Gemini branch, ~line 40-54 / the gemini case) — when managed, short-circuit the Gemini test to a success ("ใช้ Gemini ผ่านระบบ (managed) — ไม่ต้องตั้งค่า key") instead of calling Google with a (now absent) user key. Other providers unchanged.
- [ ] **Step 3: mcp/onboarding.ts** — `buildSetupGuide` (~line 75): mark Gemini `required: false` (or omit) when `process.env.MANAGED_GEMINI === "1"`; `missingKeyError("gemini")` (~38-39): when managed, return a not-needed/managed message (it shouldn't fire, since resolveGeminiKey won't throw when managed+serverKey, but make it safe); SERVER_INSTRUCTIONS Gemini-"จำเป็นเสมอ" line (~91): gate the Gemini-required wording behind `!managed`. (Pure wording polish of the rest of SERVER_INSTRUCTIONS = piece (3).)
- [ ] **Step 4: Verify** — `npx tsc --noEmit` → 0; confirm by reading: with `MANAGED_GEMINI` unset, all three handlers behave verbatim as today. State the proof.
- [ ] **Step 5: Commit** — `feat(managed): api-keys PUT ignores gemini + test-key auto-pass + MCP not-required when managed`

---

## Final whole-branch review (after Task 5)
Opus review: flag-off byte-identical across every surface (`MANAGED_GEMINI` off ⇒ BYOK intact); managed-on traces (no Gemini input/required/resolved-from-user anywhere; ElevenLabs/HeyGen/Pexels/Pixabay untouched); the ~76 stored keys are ignored-not-cleared; no non-Gemini flow broken by the hides. One fix-wave. Then present to Mew (deploy note: ships with `MANAGED_GEMINI=1` + `GEMINI_SERVER_KEY`, together with keystone + copy-sweep).

## Self-Review
- **Coverage:** resolver (T1), required-status + client signal (T2), errors (T3), client hides (T4), server save/test/MCP (T5). Copy-only reword deferred to piece (3) ✓. Stored-key handling = leave-ignored ✓.
- **Flag-off:** every change `MANAGED_GEMINI`-gated (server) or `managed`-gated (client, default false) → byte-identical off.
- **Consistency:** `managed` boolean is the single client signal (from status route); `requiredKeysFor` the single required-set source; resolveGeminiKey the single resolution point.
