// BGM resolution for the MCP path. In chat there is no music dropdown, so the
// assistant should ask the user for a MOOD/STYLE, not a filename. The 22 system
// tracks are already named by mood (e.g. "Cinematic-Dramatic", "Lofi-RnB-Laid
// Back", "Corporate-Happy") so we derive moods from the title — no DB change.
//
// resolveBgm() accepts whatever the client sends — a /music path, a track title,
// or a mood word in Thai/English ("ชิล", "chill", "เพลงสนุกๆ") — and maps it to a
// real track path. Unresolvable input is reported so the job fails fast with a
// clear message + the list of moods, instead of crashing the renderer.

export interface BgmTrack { title: string; bgmFile: string }

export interface Mood { key: string; label: string; emoji: string; titleKw: string[]; synonyms: string[] }

// Order matters: styleToMood returns the FIRST mood whose synonym appears in the
// input, so put the more specific moods before the broad "upbeat" catch-all.
export const MOODS: Mood[] = [
  // titleKw is ordered by specificity — "lofi" first so "ชิล" resolves to a Lofi
  // track, not the broader "laid back". "ambient"/"acoustic" are intentionally NOT
  // here: they live in Classical-Ambient-Cinematic / Pop-Acoustic tracks that are
  // really cinematic/upbeat, so including them mis-pulled those into chill.
  { key: "chill", label: "ชิล/สบาย", emoji: "😌",
    titleKw: ["lofi", "laid back", "peaceful", "rnb", "soulful"],
    synonyms: ["ชิล", "ชิลล์", "ชิว", "สบาย", "สบายๆ", "ผ่อนคลาย", "เบาๆ", "lofi", "lo-fi", "chill", "relax", "calm", "peaceful", "laid back", "lounge"] },
  { key: "cinematic", label: "ดราม่า/อารมณ์", emoji: "🎬",
    titleKw: ["cinematic", "dramatic", "epic", "classical", "melancholic", "sad", "sentimental"],
    synonyms: ["ดราม่า", "ดราม่", "อารมณ์", "ซึ้ง", "เศร้า", "หนัง", "อลังการ", "ยิ่งใหญ่", "cinematic", "dramatic", "epic", "emotional", "sad", "sentimental", "classical", "orchestral"] },
  { key: "corporate", label: "จริงจัง/มืออาชีพ", emoji: "💼",
    titleKw: ["corporate", "hopeful"],
    synonyms: ["จริงจัง", "ทางการ", "มืออาชีพ", "ธุรกิจ", "นำเสนอ", "corporate", "business", "professional", "formal", "presentation"] },
  { key: "playful", label: "สดใส/เล่นๆ", emoji: "🧒",
    titleKw: ["playful", "children"],
    synonyms: ["เด็ก", "สดใส", "น่ารัก", "เล่นๆ", "ขี้เล่น", "playful", "children", "kids", "cute", "cheerful"] },
  { key: "upbeat", label: "สนุก/คึกคัก", emoji: "🎉",
    titleKw: ["happy", "energetic", "upbeat", "groove", "groovy", "funk", "pop", "soul", "electronic", "hip hop"],
    synonyms: ["สนุก", "สนุกสนาน", "คึกคัก", "มันส์", "happy", "upbeat", "energetic", "fun", "groovy", "groove", "funk", "pop"] },
];

const NONE_INPUTS = ["none", "no", "ไม่", "ไม่ใส่", "ไม่เอา", "ไม่มี", "เงียบ", "ไม่ใส่เพลง", "ไม่ต้อง", "ไม่ต้องการ"];

export function isNoneInput(input: string | undefined | null): boolean {
  const s = (input ?? "").trim().toLowerCase();
  return s === "" || NONE_INPUTS.includes(s);
}

/** Which moods a track title belongs to (a title can match several). */
export function deriveMoods(title: string): string[] {
  const t = title.toLowerCase();
  return MOODS.filter((m) => m.titleKw.some((kw) => t.includes(kw))).map((m) => m.key);
}

/** Map a free-text style/mood word (Thai or English) → a canonical mood key. */
export function styleToMood(input: string): string | null {
  const low = input.trim().toLowerCase();
  if (!low) return null;
  for (const m of MOODS) {
    if (m.synonyms.some((syn) => low.includes(syn))) return m.key;
  }
  return null;
}

/** Group tracks by mood for get_video_options. Only moods with ≥1 track appear. */
export function moodBuckets(tracks: BgmTrack[]): Array<{ mood: string; label: string; emoji: string; tracks: BgmTrack[] }> {
  return MOODS.map((m) => ({
    mood: m.key,
    label: m.label,
    emoji: m.emoji,
    tracks: tracks.filter((t) => deriveMoods(t.title).includes(m.key)),
  })).filter((b) => b.tracks.length > 0);
}

export type BgmResolution =
  | { kind: "none" }
  | { kind: "resolved"; bgmFile: string; title: string; via: "path" | "title" | "mood" | "keyword" }
  | { kind: "unresolved"; input: string };

/** Resolve a client-supplied bgm value (path | title | mood word) → a real track. */
export function resolveBgm(input: string | undefined | null, tracks: BgmTrack[]): BgmResolution {
  const s = (input ?? "").trim();
  if (isNoneInput(s)) return { kind: "none" };
  const low = s.toLowerCase();

  // 1. Already a path
  if (s.startsWith("/")) {
    const hit = tracks.find((t) => t.bgmFile === s);
    if (hit) return { kind: "resolved", bgmFile: hit.bgmFile, title: hit.title, via: "path" };
    if (s.startsWith("/music/") || s.startsWith("/api/music/")) {
      return { kind: "resolved", bgmFile: s, title: s, via: "path" }; // trust a music-shaped path
    }
    return { kind: "unresolved", input: s };
  }

  // 2. Exact title (case-insensitive)
  const exact = tracks.find((t) => t.title.toLowerCase() === low);
  if (exact) return { kind: "resolved", bgmFile: exact.bgmFile, title: exact.title, via: "title" };

  // 3. Substring title match (title⊂input or input⊂title)
  const sub = tracks.find((t) => {
    const tl = t.title.toLowerCase();
    return tl.includes(low) || low.includes(tl);
  });
  if (sub) return { kind: "resolved", bgmFile: sub.bgmFile, title: sub.title, via: "title" };

  // 4. Mood word → a track in that mood, preferring the mood's most-specific keyword
  // (titleKw is ordered) so "ชิล" → a "lofi" track before a generic "laid back" one.
  const mood = styleToMood(low);
  if (mood) {
    const def = MOODS.find((m) => m.key === mood);
    for (const kw of def?.titleKw ?? []) {
      const hit = tracks.find((t) => t.title.toLowerCase().includes(kw));
      if (hit) return { kind: "resolved", bgmFile: hit.bgmFile, title: hit.title, via: "mood" };
    }
  }

  // 5. Loose keyword: any title token (≥3 chars) appears in the input
  const kw = tracks.find((t) =>
    t.title.toLowerCase().split(/[-\s]+/).some((w) => w.length >= 3 && low.includes(w)),
  );
  if (kw) return { kind: "resolved", bgmFile: kw.bgmFile, title: kw.title, via: "keyword" };

  return { kind: "unresolved", input: s };
}

/** One-line mood list for error messages / prompts, e.g. "😌 ชิล/สบาย · 🎬 ดราม่า/อารมณ์ · …". */
export function moodMenu(): string {
  return MOODS.map((m) => `${m.emoji} ${m.label}`).join(" · ") + " · ❌ ไม่ใส่เพลง";
}
