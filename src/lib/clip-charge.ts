// Clip-charge bookkeeping: count a clip's quota ONCE per video.
//
// A finished clip goes RENDER (base, no subtitles) → BURN (subtitle overlay).
// The base RENDER charges the clip (reserveClipUsage). The BURN of THAT SAME
// render must be FREE — but the "is this a burn" signal (subtitleOverlayConfig)
// is client-controlled, so we must NOT trust it to skip the charge. Instead we
// record every charged base-render output here, and a burn is free ONLY when its
// source video maps to a (userId, outputUrl) we previously charged. External /
// foreign / fabricated burn sources are not found → they charge like any render.
//
// The decision lives in pure helpers (canonicalRenderUrl + isBurnAlreadyPaid) so
// it can be unit-tested without the HTTP route (see scripts/verify-clip-charge.ts).
import { prisma } from "@/lib/prisma";

/**
 * Normalize a render URL to the canonical form we store + look up: `/api/renders/<file>`.
 *
 * Handles the variants a client can send back:
 *  - relative `/api/renders/<file>`           → unchanged (the form runRender returns)
 *  - relative `/renders/<file>`               → `/api/renders/<file>`
 *  - absolute `https://host/api/renders/<file>` (or `/renders/`) → strip origin, canonicalize path
 *
 * Anything else (external host paths, non-render URLs, empty/invalid) → null. A null
 * canonical can never match a stored charge, so such burns always fall through to a charge.
 */
export function canonicalRenderUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  let pathname = url.trim();
  if (!pathname) return null;

  // Absolute URL → take the pathname only (origin is irrelevant; same file).
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }

  // Strip any query/hash that survived a relative path.
  const q = pathname.search(/[?#]/);
  if (q !== -1) pathname = pathname.slice(0, q);

  let file: string | null = null;
  if (pathname.startsWith("/api/renders/")) file = pathname.slice("/api/renders/".length);
  else if (pathname.startsWith("/renders/")) file = pathname.slice("/renders/".length);
  else return null; // not one of OUR render outputs → can't be a paid-render reference

  // A render output is a single file (no nested path / traversal). Reject anything
  // that still contains a path separator so a crafted value can't widen the match.
  if (!file || file.includes("/") || file.includes("\\") || file.includes("..")) return null;
  return `/api/renders/${file}`;
}

/**
 * Record that `userId` was charged a clip for base-render output `outputUrl`.
 * Stores the canonical form. FAIL-OPEN: a write failure (or non-render url) must
 * never break the render — the worst case is a future burn re-charges (no bypass).
 */
export async function recordChargedClip(userId: string, outputUrl: string): Promise<void> {
  try {
    const canonical = canonicalRenderUrl(outputUrl);
    if (!canonical) return; // nothing sensible to record
    await prisma.chargedClip.create({ data: { userId, outputUrl: canonical } });
  } catch {
    // bookkeeping only — swallow
  }
}

/**
 * Is this burn referencing a base render THIS user already paid for?
 *  - true  → the user owns a charged render at this output → burn is FREE.
 *  - false → unknown / foreign / external / fabricated source → burn must CHARGE.
 *
 * FAIL-OPEN-TO-CHARGE: if the lookup throws or the url isn't canonicalizable, we
 * return false (charge), which is the SAFE direction — it can never grant a free
 * bypass, only (at worst) charge a legitimate burn that should have been free.
 */
export async function isBurnAlreadyPaid(
  userId: string,
  videoUrl: string | null | undefined,
): Promise<boolean> {
  const canonical = canonicalRenderUrl(videoUrl);
  if (!canonical) return false;
  try {
    const hit = await prisma.chargedClip.findFirst({
      where: { userId, outputUrl: canonical },
      select: { id: true },
    });
    return !!hit;
  } catch {
    return false; // safe direction: charge rather than risk a free bypass
  }
}
