# Pricing Rework — P2 deferred: Free watermark + editor minutes-chip

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** (1) overlay the HERO logo watermark on FREE-tier renders; (2) show a "X นาที (~Y คลิป)" usage chip in the editor from the `minutes` block the usage API now returns. Branch is rebased onto security-fixed main — make ADDITIVE edits, do not disturb the security agent's recent changes to `VideoComposition.tsx` / `run-render.ts` / `page.tsx`.

## Global Constraints
- Watermark asset already saved at `public/watermark.png` (HERO logo on a dark navy bg). Use `mixBlendMode: "screen"` so the dark bg disappears and only the glowing logo shows.
- Render-safe: reference the asset via Remotion `staticFile("watermark.png")`; the overlay must never throw (an `<Img>` that fails to load should not crash the render — Remotion `<Img>` is fine).
- tsc 0 errors. Visual correctness is Mew's human render-QA (not a unit test).

---

### Task 1: Free-tier watermark overlay

**Files:**
- Modify: `src/remotion/types.ts` (add `watermark?: boolean` to `VideoCompositionProps`, ~line 23)
- Modify: `src/remotion/VideoComposition.tsx` (render the overlay when `watermark` is true)
- Modify: the render-config assembly that builds the composition `inputProps` — trace from where the existing `scenes` prop is set (`src/lib/render/run-render.ts` and/or `src/app/api/videos/render/route.ts`) and add `watermark: <plan === "FREE">`. The render path has the user's `plan` (the render route authenticates the user); thread the boolean through to the inputProps.

- [ ] **Step 1:** add `watermark?: boolean;` to the `VideoCompositionProps` interface in `types.ts`.
- [ ] **Step 2:** in `VideoComposition.tsx`, import `staticFile` from `remotion` (alongside the existing `Img`); destructure `watermark` from props; add — as the LAST child of the outermost `AbsoluteFill` (so it sits on top of scenes + subtitles) — this overlay, only when `watermark`:
```tsx
{watermark && (
  <Img
    src={staticFile("watermark.png")}
    style={{
      position: "absolute", bottom: "4%", right: "4%", width: "14%",
      opacity: 0.9, mixBlendMode: "screen", pointerEvents: "none",
    }}
  />
)}
```
  Do NOT alter the existing scene/subtitle rendering or the security agent's recent edits.
- [ ] **Step 3:** in the render-config assembly, set `watermark: (plan === "FREE")` in the inputProps object passed to the composition. Find the user's plan at that layer (the render route selects/knows the user; if `run-render.ts` lacks the plan, pass it in from the route). Default `watermark` to `false` if plan is unknown (paid never watermarked).
- [ ] **Step 4:** `npx tsc --noEmit` 0 errors (run `rm -rf .next` first if stale). Commit (`feat(pricing): HERO watermark on FREE-tier renders`). Note in the report that visual QA (corner position, blend, size) is for Mew to eyeball on a real FREE render.

---

### Task 2: Editor minutes-chip

**Files:**
- Modify: the editor usage/quota chip component that calls `/api/videos/usage` (find it: `rg -n "videos/usage|usageLimit|remaining|quota" src/app/(dashboard)/video-editor` and `src/components`)

- [ ] Show the new `minutes` block from `/api/videos/usage` as a chip: `"{remaining}/{limit} นาที (~{limit} คลิป)"` next to / instead of the existing clip chip. Keep the existing clip display if it's used elsewhere; this is additive UI. `npx tsc --noEmit` 0. Commit (`feat(pricing): editor minutes usage chip`).
