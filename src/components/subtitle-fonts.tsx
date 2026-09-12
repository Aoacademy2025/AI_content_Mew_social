// Thai + decorative Google Fonts for subtitle editor.
// Includes weights 700–900 because subtitle defaults to fontWeight=900 — without
// the heavy weights the browser fakes bold by stretching, which makes Thai glyphs
// look thinner/distorted in preview vs the burned MP4. Keep this in sync with the
// Remotion font URLs in src/remotion/* — both renderers must load the same files.
const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Mitr:wght@400;500;600;700&family=Kanit:wght@400;500;600;700;800;900&family=Sarabun:wght@400;500;600;700;800&family=Prompt:wght@400;500;600;700;800;900&family=Noto+Sans+Thai:wght@400;500;600;700;800;900&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Chakra+Petch:wght@400;500;600;700&family=Chonburi&family=Fahkwang:wght@400;500;600;700&family=K2D:wght@400;500;600;700;800&family=Charm:wght@400;700&family=Bai+Jamjuree:wght@400;600;700&family=Krub:wght@400;600;700&family=Pridi:wght@400;600;700&family=Itim&family=Sriracha&family=Bangers&family=Bebas+Neue&family=Oswald:wght@400;500;600;700&family=Anton&family=Righteous&family=Playfair+Display:wght@700;800;900&family=Pacifico&family=Lobster&display=swap";

/**
 * The 24-family subtitle/style-pack Google Fonts stylesheet (107 KB CSS),
 * moved out of the root layout (perf audit Task B4 — see
 * docs/plans/reports/2026-09-12-A3-code-audit.md §A3.4). Render this only
 * from the layout/page of a route that actually draws one of the
 * subtitle-only families (the editor's subtitle picker + preview, the
 * story-film workbench, or the brand-library style-pack sample cards —
 * Sarabun/Prompt/Mitr/Noto Sans Thai/K2D/Krub/Pridi/Chonburi/Itim and the
 * burn-only decorative set). Every other route gets its app-shell families
 * (Bai Jamjuree/Kanit/IBM Plex Sans Thai) from the root layout's
 * AppShellFonts instead — see below.
 *
 * src/remotion/** loads these same font URLs itself for the actual
 * render/burn output — this component only ever affects browser preview.
 */
export function SubtitleFonts() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href={GOOGLE_FONTS_URL} rel="stylesheet" />
    </>
  );
}

// App-shell families only, at only the weights actually referenced outside
// subtitle previews (checked against source, perf audit Task B4 — see
// scripts/verify-subtitle-fonts-scope.ts's APP_SHELL_WEIGHT_REQUIREMENTS for
// the file-by-file evidence this list is a superset of):
//   - Bai Jamjuree 500/600/700 — globals.css:974 (.sale-v2-eyebrow, 600),
//     first-clip-hero.tsx (600), sale page + auth-shell headings (600/700),
//     docs h1 (700), pricing-toggle.tsx/youtube-lite.tsx (600), and (fix
//     round 2) page.tsx:188 — a font-medium(500) "CREATOR STUDIO" span
//     nested, with no fontFamily override, inside the Bai-Jamjuree-styled
//     logo span — inherits Bai Jamjuree at 500, so 500 must load too.
//   - Kanit 400/600/700 — top-nav.tsx logo badge (600), pricing-client.tsx
//     labels (600), dashboard/videos/settings/pricing/admin/admin-users/
//     admin-coupons headings (700), and (fix round 2) a font-normal(400)
//     "/ เดือน" or unit suffix span nested, with no fontFamily override,
//     inside a Kanit-styled ancestor in revenue-growth-dashboard.tsx:364,401,
//     videos/page.tsx:461-463, and pricing-client.tsx:343-348 — inherits
//     Kanit at 400. No non-editor consumer uses 800/900 — those stay in the
//     subtitle-only sheet above for the editor's own default.
//   - IBM Plex Sans Thai 400/500/600/700 — sale page + auth-shell body text
//     (400 default; 500/600 on nested elements; 700 on Clerk's headerTitle,
//     which inherits the shell's body font rather than the Bai Jamjuree HEAD).
const APP_SHELL_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Bai+Jamjuree:wght@500;600;700&family=Kanit:wght@400;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap";

/**
 * Global app-shell fonts (Bai Jamjuree, Kanit, IBM Plex Sans Thai) — every
 * route needs at least one of these (globals.css applies Bai Jamjuree to
 * `.sale-v2-eyebrow`; Kanit is used for headline numbers/headings across the
 * dashboard group; IBM Plex Sans Thai is the sale/auth body font), so this
 * renders from the root layout rather than being scoped per route. Kept
 * separate from the 24-family SubtitleFonts sheet above to avoid shipping
 * the ~15 subtitle-only families (Sarabun, Prompt, Mitr, Noto Sans Thai,
 * K2D, Krub, Pridi, Chonburi, Itim, and the burn-only decorative set) on
 * every route.
 */
export function AppShellFonts() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href={APP_SHELL_FONTS_URL} rel="stylesheet" />
    </>
  );
}
