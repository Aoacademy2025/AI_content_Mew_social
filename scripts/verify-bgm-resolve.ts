//   npx tsx scripts/verify-bgm-resolve.ts
import { resolveBgm, moodBuckets, styleToMood, isNoneInput, type BgmTrack } from "../src/lib/mcp/bgm-resolve";
let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }

// A representative slice of the real 22 system tracks (title → /music/<filename>)
const tracks: BgmTrack[] = [
  { title: "Groove", bgmFile: "/music/1778471829756-groove.mp3" },
  // Ambient-cinematic track placed BEFORE the Lofi one — this used to hijack "ชิล"
  // (via the old "ambient" keyword + first-match). The fix must still pick Lofi.
  { title: "Classical-Ambient-Cinematic", bgmFile: "/music/classical_ambient.mp3" },
  { title: "Electronic-Laid Back-Upbeat", bgmFile: "/music/electronic_laidback.mp3" },
  { title: "Lofi-RnB-Laid Back-Peaceful-Jazz", bgmFile: "/music/lofi_rnb.mp3" },
  { title: "Cinematic-Epic-Dramatic", bgmFile: "/music/cinematic_epic.mp3" },
  { title: "Corporate-Happy-Energetic", bgmFile: "/music/corporate_happy.mp3" },
  { title: "Children-Playful", bgmFile: "/music/children_playful.mp3" },
  { title: "Pop-Happy-Groovy", bgmFile: "/music/pop_happy.mp3" },
];

// exact title (kapokja's case: client sent "Groove")
const g = resolveBgm("Groove", tracks);
assert(g.kind === "resolved" && g.bgmFile === "/music/1778471829756-groove.mp3", "title 'Groove' → real path (the kapokja bug)");

// mood words (Thai) — must pick Lofi, NOT the earlier ambient/laid-back tracks
const chill = resolveBgm("ชิล", tracks);
assert(chill.kind === "resolved" && chill.via === "mood" && chill.title.startsWith("Lofi"), "'ชิล' → a Lofi track (not ambient/laid-back)");
assert(resolveBgm("ชิล", tracks).bgmFile === "/music/lofi_rnb.mp3", "'ชิล' resolves specifically to the Lofi path");
const fun = resolveBgm("เอาเพลงสนุกๆ", tracks);
assert(fun.kind === "resolved" && (fun.title.includes("Groov") || fun.title.includes("Happy") || fun.title === "Groove"), "'เพลงสนุกๆ' → an upbeat track");
const drama = resolveBgm("ดราม่า", tracks);
assert(drama.kind === "resolved" && drama.title.includes("Cinematic"), "'ดราม่า' → a cinematic track");

// English mood + path + none + unresolved
assert(resolveBgm("corporate", tracks).kind === "resolved", "'corporate' (en) resolves");
const p = resolveBgm("/music/1778471829756-groove.mp3", tracks);
assert(p.kind === "resolved" && p.via === "path", "an existing /music path stays as-is");
assert(resolveBgm("ไม่ใส่เพลง", tracks).kind === "none", "'ไม่ใส่เพลง' → none");
assert(resolveBgm("", tracks).kind === "none", "empty → none");
assert(resolveBgm("zxqw-not-a-thing", tracks).kind === "unresolved", "gibberish → unresolved");

// helpers
assert(isNoneInput("ไม่เอา") && !isNoneInput("Groove"), "isNoneInput");
assert(styleToMood("ชิลๆ") === "chill" && styleToMood("epic หนัง") === "cinematic", "styleToMood Thai+en");
const buckets = moodBuckets(tracks);
assert(buckets.length >= 4 && buckets.every((b) => b.tracks.length > 0), "moodBuckets groups tracks, no empty buckets");
assert(buckets.some((b) => b.mood === "chill") && buckets.some((b) => b.mood === "cinematic"), "buckets include chill + cinematic");

console.log(`\n${passed} checks passed`);
