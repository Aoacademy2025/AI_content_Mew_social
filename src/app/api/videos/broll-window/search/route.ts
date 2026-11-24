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
  brollPreferenceCacheVariant,
  normalizeBrollRegionPreference,
  normalizeBrollVisualStyle,
  type BrollPreferenceInput,
} from "@/lib/broll-preferences";
import { parseStockMoodRequest } from "@/lib/style-pack-snapshot";
import {
  BROLL_WINDOW_SEARCH_ERROR_MESSAGES,
  searchWindowCandidatesWithDegrade,
  type WindowSearchOutcome,
} from "@/lib/broll-window-search";
import {
  MANAGED_STOCK_WINDOW_SEARCH_MAX_QUERIES_PER_REQUEST,
  ManagedStockJobBudget,
  shouldQueryPexelsAfterPixabay,
  type ManagedStockProvider,
  type ManagedStockThrottleScope,
} from "@/lib/managed-stock";
import {
  hasManagedStockMonthlyBudget,
  pruneExpiredStockSearchCache,
  readStockSearchCache,
  recordManagedStockCall,
  recordManagedStockThrottled,
  recordManagedStockUsed,
  resolveManagedStockAccess,
  takeManagedStockToken,
  takeManagedStockUserSearchToken,
  writeStockSearchCache,
} from "@/lib/managed-stock.server";

// POST /api/videos/broll-window/search — Phase 2 "เปลี่ยนสต็อก" tab (Task 7, HERO-120).
// Given the window's (editable) keyword, searches Pexels / Pixabay and returns
// portrait-only candidates for the client to pick from. Read-only — no download
// happens here (that's /select). Internal AI testers receive the beta before
// NEXT_PUBLIC_BROLL_WINDOW_EDIT opens it publicly; everyone else gets a 404.
//
// Credential resolution follows ADR 0025 + Amendment 2026-08-26:
//   • BYOK always wins: if the user has a personal Pexels or Pixabay key, search
//     runs on their own key(s) in parallel with zero managed-stock quota spent.
//   • No personal stock keys + MANAGED_STOCK=1 eligible: search runs on the team
//     keys with Pixabay tried first (Pexels only when Pixabay returns < 3 hits),
//     honoring the 24h StockSearchCache, per-user hourly cap, per-request cap,
//     monthly Pexels ceiling, and global provider token buckets.
//   • Fail closed (never fall back to paid AI providers) when MANAGED_STOCK is off,
//     the account is suspended, or managed-stock caps/throttles block all providers.
//
// The project's Step-2 preferences ("คนและสถานที่" / Stock Mood) qualify the
// query here too — searching the raw keyword was why swapping a window ignored the
// preferences entirely (F7 cause #3). If the qualified query GENUINELY finds nothing we
// search the plain keyword once: the same degrade rule the render pipeline's fallback
// queries use, on two FREE stock APIs — never a hidden retry of a paid generation.
// A zero caused by every provider failing or being throttled is NOT a genuine zero
// and must not widen — that would only double the failing/throttled calls.

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

type ManagedThrottleReason = "user_rate" | "provider_rate" | "month_budget" | "request_budget";

type ManagedProviderOutcome<T> =
  | { status: "ok"; items: T[] }
  | { status: "throttled"; reason: ManagedThrottleReason }
  | { status: "error"; error: unknown };

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
  const userId = user.id;

  const body = (await req.json().catch(() => null)) as
    | { keyword?: unknown; brollRegionPreference?: unknown; brollVisualStyle?: unknown; stockMood?: unknown }
    | null;
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim().slice(0, 200) : "";
  if (!keyword) {
    return NextResponse.json({ error: "invalid_keyword", message: "กรุณาระบุคำค้นหาก่อนค้นหาคลิป" }, { status: 400 });
  }

  const ownPexelsKey = (user.pexelsKey ? decryptKey(user.pexelsKey) : "").trim() || null;
  const ownPixabayKey = (user.pixabayKey ? decryptKey(user.pixabayKey) : "").trim() || null;

  // Managed stock access (ADR 0025): BYOK always wins; flag-off / suspended / no
  // server keys fail closed with zero DB work.
  const managedStock = await resolveManagedStockAccess(user, {
    hasOwnPexelsKey: Boolean(ownPexelsKey),
    hasOwnPixabayKey: Boolean(ownPixabayKey),
  });
  const pexelsKey = ownPexelsKey ?? managedStock.pexelsKey;
  const pixabayKey = ownPixabayKey ?? managedStock.pixabayKey;
  const usesManagedStock =
    managedStock.eligible && !ownPexelsKey && !ownPixabayKey && Boolean(pexelsKey || pixabayKey);

  if (!pexelsKey && !pixabayKey) {
    if (managedStock.reason === "suspended") {
      return NextResponse.json(
        { error: "account_suspended", message: BROLL_WINDOW_SEARCH_ERROR_MESSAGES.account_suspended },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: "missing_key",
        missingKey: "broll",
        message: BROLL_WINDOW_SEARCH_ERROR_MESSAGES.missing_key,
      },
      { status: 400 },
    );
  }

  // Unlike the render pipeline the editor client calls this route directly, so
  // the Stock Mood it shows in Step 2 arrives in the body. Never trusted raw —
  // and a malformed one is IGNORED, so a bad mood degrades the search to the
  // plain keyword instead of denying the creator a swap.
  const stockMood = parseStockMoodRequest(body?.stockMood, { route: "POST /api/videos/broll-window/search" });
  const preference: BrollPreferenceInput = {
    brollRegionPreference: normalizeBrollRegionPreference(body?.brollRegionPreference),
    // The editor stopped sending this with the Step-2 menu; the route keeps
    // accepting it so a browser tab still running pre-wave-1 JS across a deploy
    // behaves as it did. One style system (ADR 0057): a pack retires it.
    brollVisualStyle: stockMood ? undefined : normalizeBrollVisualStyle(body?.brollVisualStyle),
    stockMood,
  };
  const styledKeyword = applyBrollPreferenceToSearchQuery(keyword, preference, { role: "primary" }) || keyword;
  const stockCacheVariant = brollPreferenceCacheVariant(preference);

  const managedBudget = usesManagedStock
    ? new ManagedStockJobBudget(MANAGED_STOCK_WINDOW_SEARCH_MAX_QUERIES_PER_REQUEST)
    : null;
  const managedStats: Record<
    ManagedStockProvider,
    { queries: number; cacheHits: number; throttleScope: ManagedStockThrottleScope | null }
  > = {
    pixabay: { queries: 0, cacheHits: 0, throttleScope: null },
    pexels: { queries: 0, cacheHits: 0, throttleScope: null },
  };
  let managedTelemetryEmitted = false;
  let lastOutcomeAllProvidersFailed = false;
  let lastThrottleReason: ManagedThrottleReason | null = null;

  async function emitManagedStockTelemetry() {
    if (!usesManagedStock || managedTelemetryEmitted) return;
    managedTelemetryEmitted = true;
    for (const provider of ["pixabay", "pexels"] as ManagedStockProvider[]) {
      const stat = managedStats[provider];
      if (stat.queries === 0 && stat.cacheHits === 0 && !stat.throttleScope) continue;
      const payload = {
        provider,
        queriesUsed: stat.queries,
        cacheHits: stat.cacheHits,
        step: "brollWindowSearch",
      };
      if (stat.throttleScope) {
        await recordManagedStockThrottled(userId, { ...payload, scope: stat.throttleScope });
      }
      if (stat.queries > 0 || stat.cacheHits > 0) {
        await recordManagedStockUsed(userId, payload);
      }
    }
    void pruneExpiredStockSearchCache();
  }

  async function managedProviderSearch<T>(
    provider: ManagedStockProvider,
    params: { query: string; perPage: number; minDuration: number },
    run: () => Promise<T[]>,
    userRateAlreadyTripped = false,
  ): Promise<ManagedProviderOutcome<T>> {
    const cacheParams = { provider, ...params, variant: stockCacheVariant };
    const cached = await readStockSearchCache<T>(cacheParams);
    if (cached) {
      managedStats[provider].cacheHits++;
      return { status: "ok", items: cached };
    }
    if (userRateAlreadyTripped) {
      return { status: "throttled", reason: "user_rate" };
    }
    if (!managedBudget?.take()) {
      managedStats[provider].throttleScope ??= "rate";
      return { status: "throttled", reason: "request_budget" };
    }
    if (!(await hasManagedStockMonthlyBudget(provider))) {
      managedStats[provider].throttleScope = "month";
      return { status: "throttled", reason: "month_budget" };
    }
    if (!takeManagedStockUserSearchToken(userId)) {
      managedStats[provider].throttleScope ??= "rate";
      return { status: "throttled", reason: "user_rate" };
    }
    if (!takeManagedStockToken(provider)) {
      managedStats[provider].throttleScope ??= "rate";
      return { status: "throttled", reason: "provider_rate" };
    }
    managedStats[provider].queries++;
    await recordManagedStockCall(provider);
    try {
      const results = await run();
      await writeStockSearchCache(cacheParams, results);
      return { status: "ok", items: results };
    } catch (error) {
      return { status: "error", error };
    }
  }

  function mapPexelsVideos(videos: PexelsVideo[]): Candidate[] {
    const out: Candidate[] = [];
    for (const v of videos) {
      const file = pickBestPexelsFile(v);
      if (!file) continue; // portrait-only — no portrait file for this hit → skip
      out.push({
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
    return out;
  }

  function mapPixabayVideos(videos: PixabayVideo[]): Candidate[] {
    const out: Candidate[] = [];
    for (const pv of videos) {
      if (!pv.videoUrl) continue; // searchPixabay already filters portrait/unknown-orientation
      const title = pv.tags ? pv.tags.split(",").slice(0, 6).map((t) => t.trim()).join(" ") : keyword;
      out.push({
        id: `pixabay:${pv.id}`,
        provider: "pixabay",
        thumb: pv.thumb ?? "",
        videoUrl: pv.videoUrl,
        duration: pv.duration,
        title,
      });
    }
    return out;
  }

  async function searchCandidates(query: string): Promise<WindowSearchOutcome<Candidate>> {
    if (usesManagedStock) {
      let asked = 0;
      let answered = 0;
      let throttleReason: ManagedThrottleReason | null = null;
      let pixabayCandidates: Candidate[] = [];
      let pexelsCandidates: Candidate[] = [];

      if (pixabayKey) {
        asked += 1;
        const pixabayOutcome = await managedProviderSearch<PixabayVideo>(
          "pixabay",
          { query, perPage: PER_PAGE, minDuration: MIN_DURATION_SEC },
          () => searchPixabay(query, pixabayKey, MIN_DURATION_SEC, PER_PAGE),
        );
        if (pixabayOutcome.status === "ok") {
          answered += 1;
          pixabayCandidates = mapPixabayVideos(pixabayOutcome.items);
        } else if (pixabayOutcome.status === "throttled") {
          throttleReason = pixabayOutcome.reason;
        } else {
          console.warn("[broll-window/search] managed pixabay search failed:", pixabayOutcome.error);
        }
      }

      if (pexelsKey && shouldQueryPexelsAfterPixabay(pixabayCandidates.length)) {
        asked += 1;
        const pexelsOutcome = await managedProviderSearch<PexelsVideo>(
          "pexels",
          { query, perPage: PER_PAGE, minDuration: MIN_DURATION_SEC },
          () => searchPexels(query, pexelsKey, MIN_DURATION_SEC, PER_PAGE),
          throttleReason === "user_rate",
        );
        if (pexelsOutcome.status === "ok") {
          answered += 1;
          pexelsCandidates = mapPexelsVideos(pexelsOutcome.items);
        } else if (pexelsOutcome.status === "throttled") {
          throttleReason ??= pexelsOutcome.reason;
        } else {
          console.warn("[broll-window/search] managed pexels search failed:", pexelsOutcome.error);
        }
      }

      const out = [...pixabayCandidates, ...pexelsCandidates].slice(0, MAX_CANDIDATES);
      const allProvidersFailed = asked > 0 && answered === 0;
      lastOutcomeAllProvidersFailed = allProvidersFailed;
      if (allProvidersFailed && throttleReason) {
        lastThrottleReason = throttleReason;
      } else if (answered > 0) {
        lastThrottleReason = null;
      }
      return {
        candidates: out,
        allProvidersFailed,
      };
    }

    // Only a provider we actually hold a key for can succeed or fail; the other
    // resolves [] without ever being asked.
    const askedPexels = Boolean(pexelsKey);
    const askedPixabay = Boolean(pixabayKey);
    const [pexelsRes, pixabayRes] = await Promise.allSettled([
      pexelsKey ? searchPexels(query, pexelsKey, MIN_DURATION_SEC, PER_PAGE) : Promise.resolve([] as PexelsVideo[]),
      pixabayKey ? searchPixabay(query, pixabayKey, MIN_DURATION_SEC, PER_PAGE) : Promise.resolve([] as PixabayVideo[]),
    ]);

    const pexelsCandidates = pexelsRes.status === "fulfilled" ? mapPexelsVideos(pexelsRes.value) : [];
    if (pexelsRes.status === "rejected") {
      console.warn("[broll-window/search] pexels search failed:", pexelsRes.reason);
    }

    const pixabayCandidates = pixabayRes.status === "fulfilled" ? mapPixabayVideos(pixabayRes.value) : [];
    if (pixabayRes.status === "rejected") {
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
  // An all-providers-failed/throttled zero never widens — avoiding a second
  // doomed round of calls.
  const candidates = await searchWindowCandidatesWithDegrade<Candidate>({
    styledQuery: styledKeyword,
    plainKeyword: keyword,
    search: searchCandidates,
    onDegrade: (styled) =>
      console.log(`[broll-window/search] "${styled}" found 0 — degrading to the plain keyword`),
  });

  await emitManagedStockTelemetry();

  if (usesManagedStock && candidates.length === 0 && lastOutcomeAllProvidersFailed && lastThrottleReason) {
    if (lastThrottleReason === "month_budget") {
      return NextResponse.json(
        {
          error: "managed_stock_budget_exceeded",
          message: BROLL_WINDOW_SEARCH_ERROR_MESSAGES.managed_stock_budget_exceeded,
        },
        { status: 429 },
      );
    }
    return NextResponse.json(
      {
        error: "managed_stock_rate_limited",
        message: BROLL_WINDOW_SEARCH_ERROR_MESSAGES.managed_stock_rate_limited,
      },
      { status: 429 },
    );
  }

  return NextResponse.json({ candidates });
}
