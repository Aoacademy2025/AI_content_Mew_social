// Unit tests for src/lib/broll-source-quality.ts
// (run: npx tsx scripts/verify-broll-source-quality.ts)
//   clampedLongSide  → #9 HD tiebreak metric (provider-bias-neutral)
//   pickPixabayVariant → #8 soft resolution floor (must NOT reintroduce 4K → respects #63)
import { clampedLongSide, pickPixabayVariant } from "../src/lib/broll-source-quality";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── clampedLongSide (#9) ──
check("clamp: landscape long side", clampedLongSide(1280, 720) === 1280);
check("clamp: portrait long side", clampedLongSide(720, 1280) === 1280);
check("clamp: 4K capped to 1920", clampedLongSide(3840, 2160) === 1920);
check("clamp: portrait 4K capped to 1920", clampedLongSide(2160, 3840) === 1920);
check("clamp: unknown → 0", clampedLongSide(undefined, undefined) === 0);
// provider-bias neutrality: anything ≥1920 ranks EQUAL (so Pixabay's bigger raw dims can't always win)
check("clamp: ≥FullHD ranks equal (no provider bias)",
  clampedLongSide(3840, 2160) === clampedLongSide(1920, 1080),
  `${clampedLongSide(3840, 2160)} === ${clampedLongSide(1920, 1080)}`);
check("clamp: sharper sub-HD beats softer", clampedLongSide(1280, 720) > clampedLongSide(854, 480));

// ── pickPixabayVariant (#8) ──
{
  // normal: medium is fine (long side ≥720) → keep medium, never download large/4K
  const r = pickPixabayVariant({ url: "med", width: 1280, height: 720 }, { url: "lg", width: 3840, height: 2160 });
  check("pick: healthy medium kept (avoids 4K)", r.url === "med" && r.width === 1280);
}
{
  // soft medium (long side <720) + large ≤1920 → upgrade to large
  const r = pickPixabayVariant({ url: "med", width: 360, height: 640 }, { url: "lg", width: 1080, height: 1920 });
  check("pick: sub-720 medium → upgrade to ≤1920 large", r.url === "lg" && r.height === 1920);
}
{
  // soft medium + large is 4K (>1920) → MUST keep medium (respect #63, don't pull 4K)
  const r = pickPixabayVariant({ url: "med", width: 360, height: 640 }, { url: "lg", width: 2160, height: 3840 });
  check("pick: #63-respect — sub-720 medium but large is 4K → keep medium (no 4K download)", r.url === "med");
}
{
  // medium missing, large ≤1920 → use large
  const r = pickPixabayVariant(undefined, { url: "lg", width: 1080, height: 1920 });
  check("pick: no medium → use ≤1920 large", r.url === "lg");
}
{
  // dimensions unknown → behaves like legacy medium ?? large
  const r = pickPixabayVariant({ url: "med" }, { url: "lg" });
  check("pick: unknown dims → legacy medium-first", r.url === "med");
}
{
  const r = pickPixabayVariant(undefined, undefined);
  check("pick: nothing → empty url", r.url === "");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
