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
 * from the layout/page of a route that actually draws one of these families
 * (the editor's subtitle picker + preview, the story-film workbench, the
 * brand-library style-pack sample cards, or the first-clip dashboard hero).
 * Every other route keeps just Inter (src/app/layout.tsx, self-hosted) or,
 * where only Bai Jamjuree/IBM Plex Sans Thai is needed, its own minimal
 * single-purpose link (src/app/page.tsx, src/components/marketing/auth-shell.tsx).
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
