import { SubtitleFonts } from "@/components/subtitle-fonts";

// StoryFilmWorkbench.tsx renders Sarabun/Prompt/Mitr preview text — see
// docs/plans/reports/2026-09-12-A3-code-audit.md §A3.4. Scoped to this
// nested route only; the parent /ai-studio route does not need the sheet.
export default function StoryFilmLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SubtitleFonts />
      {children}
    </>
  );
}
