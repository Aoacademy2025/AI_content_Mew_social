import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { decryptKey } from "@/lib/key-crypto";
import {
  searchPexels,
  searchPixabay,
  type PexelsVideo,
  type PexelsVideoFile,
  type PixabayVideo,
} from "@/lib/broll-asset-lib";
import { isInternalAiBetaEnabledFor } from "@/lib/internal-ai-access";
import {
  applyBrollPreferenceToSearchQuery,
  normalizeBrollRegionPreference,
  normalizeBrollVisualStyle,
  type BrollPreferenceInput,
} from "@/lib/broll-preferences";
import {
  searchWindowCandidatesWithDegrade,
  type WindowSearchOutcome,
} from "@/lib/broll-window-search";

// POST /api/videos/broll-window/search — Phase 2 "เปลี่ยนรูป" tab (Task 7).
// Given the window's (editable) keyword, searches Pexels + Pixabay in parallel and
// returns portrait-only candidates for the client to pick from. Read-only — no
// download happens here (that's /select). Internal AI testers receive the beta before
// NEXT_PUBLIC_BROLL_WINDOW_EDIT opens it publicly; everyone else gets a 404.
//
// The project's Step-2 preferences ("คนและสถานที่" / "สไตล์ฟุตเทจสต็อก") qualify the
// query here too — searching the raw keyword was why swapping a window ignored the
// preferences entirely (F7 cause #3). If the qualified query GENUINELY finds nothing we
// search the plain keyword once: the same degrade rule the render pipeline's fallback
// queries use, on two FREE stock APIs — never a hidden retry of a paid generation.
// A zero caused by every provider failing (outage, revoked or rate-limited key) is NOT
// a genuine zero and must not widen — that would only double the failing calls.

export const runtime = "nodejs";

const MAX_CANDIDATES = 12;
const MIN_DURATION_SEC = 3;
const PER_PAGE = 15;

type Candidate = {
  id: string;
  provider: "pexels" | "pixabay";
  thumb: string;
  videoUrl: string;
  duration: number;
  title: string;
};

// Mirrors `pickBestFile` in fetch-stock/route.ts (module-private there, so
// re-implemented here): HD portrait ≤1080p preferred, any portrait accepted,
// landscape-only hits skipped entirely (never crop landscape into 9:16).
function pickBestPexelsFile(video: PexelsVideo): PexelsVideoFile | null {
  const files = video.video_files.filter((f) => f.file_type === "video/mp4");
  const under1080 = (f: PexelsVideoFile) => Math.max(f.width, f.height) <= 1920;
  const portrait = files.filter((f) => f.height > f.width);
  const hdPortrait = portrait.filter(under1080).find((f) => f.quality === "hd") ?? portrait.filter(under1080)[0];
  if (hdPortrait) return hdPortrait;
  if (portrait[0]) return portrait[0]; // fallback: any portrait even if large
  return null;
}

// Mirrors fetch-stock's slugToTitle: "https://www.pexels.com/video/woman-cooking-soup-1234567/" -> "woman cooking soup"
function slugToTitle(url: string): string {
  try {
    const slug = new URL(url).pathname.replace(/^\/video\//, "").replace(/\/$/, "");
    return slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
  } catch {
    return "";
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  const publicEnabled = process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT === "1";
  if (!user) return NextResponse.json({ error: publicEnabled ? "Unauthorized" : "not_enabled" }, { status: publicEnabled ? 401 : 404 });
  if (!isInternalAiBetaEnabledFor(user, publicEnabled)) {
    return NextResponse.json({ error: "not_enabled" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as
    | { keyword?: unknown; brollRegionPreference?: unknown; brollVisualStyle?: unknown }
    | null;
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim().slice(0, 200) : "";
  if (!keyword) {
    return NextResponse.json({ error: "invalid_keyword", message: "กรุณาระบุคำค้นหาก่อนค้นหาคลิป" }, { status: 400 });
  }

  if (!user.pexelsKey && !user.pixabayKey) {
    return NextResponse.json(
      { error: "missing_key", missingKey: "broll", message: "ต้องใส่ Pexels หรือ Pixabay key อย่างน้อย 1 ตัวสำหรับ B-roll (Settings → API Keys)" },
      { status: 400 },
    );
  }

  const pexelsKey = user.pexelsKey ? decryptKey(user.pexelsKey) : null;
  const pixabayKey = user.pixabayKey ? decryptKey(user.pixabayKey) : null;

  const preference: BrollPreferenceInput = {
    brollRegionPreference: normalizeBrollRegionPreference(body?.brollRegionPreference),
    brollVisualStyle: normalizeBrollVisualStyle(body?.brollVisualStyle),
  };
  const styledKeyword = applyBrollPreferenceToSearchQuery(keyword, preference, { role: "primary" }) || keyword;

  async function searchCandidates(query: string): Promise<WindowSearchOutcome<Candidate>> {
    // Only a provider we actually hold a key for can succeed or fail; the other
    // resolves [] without ever being asked.
    const askedPexels = Boolean(pexelsKey);
    const askedPixabay = Boolean(pixabayKey);
    const [pexelsRes, pixabayRes] = await Promise.allSettled([
      pexelsKey ? searchPexels(query, pexelsKey, MIN_DURATION_SEC, PER_PAGE) : Promise.resolve([] as PexelsVideo[]),
      pixabayKey ? searchPixabay(query, pixabayKey, MIN_DURATION_SEC, PER_PAGE) : Promise.resolve([] as PixabayVideo[]),
    ]);

    const pexelsCandidates: Candidate[] = [];
    if (pexelsRes.status === "fulfilled") {
      for (const v of pexelsRes.value) {
        const file = pickBestPexelsFile(v);
        if (!file) continue; // portrait-only — no portrait file for this hit → skip
        pexelsCandidates.push({
          id: `pexels:${v.id}`,
          provider: "pexels",
          thumb: v.image ?? "",
          videoUrl: file.link,
          duration: v.duration,
          // The creator's own keyword stays the label — the qualified query is a
          // search detail, not something to rename their clip with.
          title: slugToTitle(v.url ?? "") || keyword,
        });
      }
    } else {
      console.warn("[broll-window/search] pexels search failed:", pexelsRes.reason);
    }

    const pixabayCandidates: Candidate[] = [];
    if (pixabayRes.status === "fulfilled") {
      for (const pv of pixabayRes.value) {
        if (!pv.videoUrl) continue; // searchPixabay already filters portrait/unknown-orientation
        const title = pv.tags ? pv.tags.split(",").slice(0, 6).map((t) => t.trim()).join(" ") : keyword;
        pixabayCandidates.push({
          id: `pixabay:${pv.id}`,
          provider: "pixabay",
          thumb: pv.thumb ?? "",
          videoUrl: pv.videoUrl,
          duration: pv.duration,
          title,
        });
      }
    } else {
      console.warn("[broll-window/search] pixabay search failed:", pixabayRes.reason);
    }

    // Interleave the two providers (round-robin) so the capped-12 list isn't
    // dominated by whichever provider happened to return first/deeper.
    const out: Candidate[] = [];
    const max = Math.max(pexelsCandidates.length, pixabayCandidates.length);
    for (let i = 0; i < max && out.length < MAX_CANDIDATES; i++) {
      if (pexelsCandidates[i]) out.push(pexelsCandidates[i]);
      if (out.length >= MAX_CANDIDATES) break;
      if (pixabayCandidates[i]) out.push(pixabayCandidates[i]);
    }
    const asked = (askedPexels ? 1 : 0) + (askedPixabay ? 1 : 0);
    const answered =
      (askedPexels && pexelsRes.status === "fulfilled" ? 1 : 0)
      + (askedPixabay && pixabayRes.status === "fulfilled" ? 1 : 0);
    return {
      candidates: out.slice(0, MAX_CANDIDATES),
      allProvidersFailed: asked > 0 && answered === 0,
    };
  }

  // Degrade, not retry: a qualified query that genuinely found nothing widens
  // back to exactly what the creator typed rather than showing an empty tab.
  // An all-providers-failed zero keeps the existing behaviour — the warn above
  // plus an empty list — without a second doomed round of calls.
  const candidates = await searchWindowCandidatesWithDegrade<Candidate>({
    styledQuery: styledKeyword,
    plainKeyword: keyword,
    search: searchCandidates,
    onDegrade: (styled) =>
      console.log(`[broll-window/search] "${styled}" found 0 — degrading to the plain keyword`),
  });

  return NextResponse.json({ candidates });
}
