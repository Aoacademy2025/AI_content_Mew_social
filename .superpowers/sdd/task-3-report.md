# Task 3 Report — Pipeline wired to resolver + minute meter

## Status: DONE (original task)

## Commit: b106459

## Build / test result
- `npx tsc --noEmit` → 0 errors
- `npx tsx scripts/verify-gemini-key.ts` → ok gemini-key
- `npx tsx scripts/verify-minute-meter.ts` → ✅ ALL 24 MINUTE-METER CHECKS PASSED (includes 5 new Task-3 checks)

---

## Files touched

| File | Change |
|---|---|
| `src/lib/gemini-key.ts` | Added base64 decode of BYOK key before returning — callers receive a ready-to-use API key, not the stored encoded value |
| `src/app/api/videos/tts-gemini/route.ts` | Full wiring: resolveGeminiKey + plan in select; checkMinuteQuota precheck (managed only); reserveMinutes after audio produced in both segmented-success and fail-open paths |
| `src/app/api/contents/generate/route.ts` | Resolver wired; old fallback to GEMINI_API_KEY env removed (resolveGeminiKey handles it via GEMINI_SERVER_KEY) |
| `src/app/api/styles/analyze/route.ts` | Resolver wired |
| `src/app/api/videos/align-scenes/route.ts` | Resolver wired |
| `src/app/api/videos/analyze-script/route.ts` | Resolver wired |
| `src/app/api/videos/split-phrases/route.ts` | Resolver wired |
| `src/app/api/videos/split-script/route.ts` | Resolver wired |
| `src/app/api/videos/thumbnail/route.ts` | Resolver wired; removed local `decrypt()` usage |
| `src/app/api/videos/transcribe/route.ts` | Resolver wired with catch (KeyRequiredError → resolvedGeminiKey=null preserves Gemini-or-fail behaviour); no-key path now 409 KEY_REQUIRED instead of 401 |
| `scripts/verify-gemini-key.ts` | Updated to use base64-encoded storedKey as input; added empty-string test |
| `scripts/verify-minute-meter.ts` | Extended with 5 Task-3 checks: over-quota path (Thai message), managed/byok branch logic |

---

## Metering branch logic (tts-gemini)

```
resolve → { key, mode }
if mode === "managed":
  precheck: checkMinuteQuota → 409 QUOTA_MINUTES if !allowed  (before TTS work)
  ...TTS runs...
  after audio: reserveMinutes(max(1, ceil(durationMs/60_000))) → 409 if !allowed
if mode === "byok":
  nothing — BYOK users pay Google directly, no metering
```

Both the segmented-success path and the fail-open single-call path have reserveMinutes.

---

## Flag-OFF invariant
With `MANAGED_GEMINI` unset, a user WITH their own key: `resolveGeminiKey` returns `{ key: decodedKey, mode: "byok" }`. The `geminiMode === "managed"` guards are both false, so no quota checks run. Behaviour is byte-for-byte unchanged.

A no-key user with flag OFF: `KeyRequiredError` is caught → 409 `KEY_REQUIRED` (cleaner than the previous mix of 400/401/500 depending on route).

---

## Deferred / concerns
- `contents/generate` previously fell back to `process.env.GEMINI_API_KEY` (a different env from `GEMINI_SERVER_KEY`). That fallback is now gone — the managed path uses `GEMINI_SERVER_KEY`. If prod had `GEMINI_API_KEY` set without `MANAGED_GEMINI=1`, this route now throws 409 for no-key users instead of using that env. This is correct per the managed-key design but worth noting for ops.
- Minute metering is NOT applied to the `preview=true` path in tts-gemini (voice sample previews). These are short clips; metering them adds friction with minimal benefit. Easy to add if desired.
- Routes other than tts-gemini (split-script, split-phrases, etc.) get resolver wiring but NO minute metering — they're text-only LLM calls, not audio generation, so per the brief's design rules they are out of scope for the minute meter.

---

# Task-3 Review Fixes

## Status: DONE

## Fixes applied

### FIX 1 (Critical) — Reserve-before-save in segmented-success path
**File:** `src/app/api/videos/tts-gemini/route.ts`
Moved `saveWav(...)` to AFTER `reserveMinutes` in the segmented-success path. Now: compute `audioDurationMs` → `reserveMinutes` (managed only, return 409 on failure with no file written) → `saveWav`. The fail-open path already did this correctly; both paths are now consistent.

### FIX 2 (Spec gap) — Wire extract-keywords to resolveGeminiKey
**File:** `src/app/api/videos/extract-keywords/route.ts`
Added `import { resolveGeminiKey, KeyRequiredError }` from gemini-key; added `plan: true` to Prisma select; added `if (!user)` 404 guard; replaced local `decrypt()`+raw-key path with `resolveGeminiKey(user).key` wrapped in try/catch for `KeyRequiredError` → 409 `{ code: "KEY_REQUIRED", action: "/settings?tab=api-keys" }`; removed local `decrypt()` function; removed non-null assertion `apiKey!` in `callLLM`.

### FIX 3 (UX/spec) — Don't block voice previews with quota precheck
**File:** `src/app/api/videos/tts-gemini/route.ts`
Moved `checkMinuteQuota` block from before the `if (preview === true)` branch to after it (real-render path only). Previews are never metered or quota-blocked.

### FIX 4 (Minor) — Remove dead `decrypt()` from thumbnail route
**File:** `src/app/api/videos/thumbnail/route.ts`
Removed dead `function decrypt(k: string)` (~line 12) — no longer called after resolver wiring.

### FIX 5 (Minor) — Drop trivial shouldMeter test
**File:** `scripts/verify-minute-meter.ts`
Removed the 4-line `shouldMeter` inline assertion block. Kept all 22 remaining meaningful assertions.

## Commands and output

```
npx tsc --noEmit
# → (no output, 0 errors)

DATABASE_URL="file:$(pwd)/prisma/test-minute-meter.db?connection_limit=1" npx tsx scripts/verify-minute-meter.ts
# → ✅ ALL 22 MINUTE-METER CHECKS PASSED

npx tsx scripts/verify-gemini-key.ts
# → ok gemini-key
```
