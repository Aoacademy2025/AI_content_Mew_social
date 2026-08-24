# Pricing Rework — P1.x: resolver coverage gaps (post-security-rebase)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Finish P1's managed/BYOK resolver coverage on the two surfaces deferred during the security agent's parallel work: `fetch-stock` (b-roll keyword LLM ranker) and the MCP `create_video_job` entry. Branch is now rebased onto the security-fixed `origin/main`.

**Constraint:** the security agent just hardened `fetch-stock` (SSRF via `@/lib/safe-fetch`) and the MCP/IDOR paths. Add the resolver WITHOUT disturbing those guards.

## Global Constraints
- Reuse `resolveGeminiKey(user)→{key,mode}` + `KeyRequiredError` from `@/lib/gemini-key` (built in P1). Keys are base64-stored; the resolver already decodes.
- Flag behaviour: with `MANAGED_GEMINI` off + a BYOK user → byte-identical to today.
- tsc 0 errors. No new test framework.

---

### Task 1: Resolver in fetch-stock + MCP create_video_job

**Files:**
- Modify: `src/app/api/videos/fetch-stock/route.ts` (the spot that reads `user.geminiKey` for the b-roll keyword LLM ranker — `rg -n "user\.geminiKey|geminiKey" src/app/api/videos/fetch-stock/route.ts`)
- Modify: `src/app/api/[transport]/route.ts` (MCP `create_video_job` — the `if (!u.geminiKey) return missingKeyError("gemini")` hard-block, `rg -n "geminiKey|missingKeyError" src/app/api/[transport]/route.ts`)
- Test: `scripts/verify-resolver-coverage.ts` (a focused tsc-adjacent check is not feasible for routes; rely on `tsc` + a small unit assertion if a pure helper is extracted)

- [ ] **Step 1 (fetch-stock):** locate where the user's Gemini key is read for the LLM keyword ranker (currently `Buffer.from(user.geminiKey,"base64")` or raw `user.geminiKey`). Ensure the user select includes `plan: true`. Replace the key read with `resolveGeminiKey(user)` — wrap in try/catch: on `KeyRequiredError`, set the LLM key to null and let the existing non-LLM heuristic fallback run (do NOT 500; b-roll must still work via Pexels/Pixabay). Do NOT touch the `isSafeFetchUrl`/SSRF logic the security agent added.
- [ ] **Step 2 (MCP):** in `src/app/api/[transport]/route.ts` `create_video_job`, replace the hard `if (!u.geminiKey) return missingKeyError("gemini")` so a managed user (no own key, `MANAGED_GEMINI=1`) is allowed: use `try { resolveGeminiKey(u); } catch (e) { if (e instanceof KeyRequiredError) return missingKeyError("gemini"); throw e; }` — i.e. only block when the resolver itself says KEY_REQUIRED (no BYOK key AND managed off). Keep the rest of the MCP flow unchanged.
- [ ] **Step 3:** `npx tsc --noEmit` 0 errors (ignore stale `.next/types` for the deleted `videos/webhook` route — run `rm -rf .next` first if it pollutes); re-run the P1/P2/P3 verify suites (unaffected). Commit (`feat(pipeline): resolver coverage for fetch-stock ranker + MCP create_video_job`).
