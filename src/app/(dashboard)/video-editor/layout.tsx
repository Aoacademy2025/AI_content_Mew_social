import { SubtitleFonts } from "@/components/subtitle-fonts";

// The editor's subtitle style picker + live preview render text in all 12
// editor-picker families (Kanit, Noto Sans Thai, Bai Jamjuree, IBM Plex Sans
// Thai, Sarabun, Prompt, Mitr, K2D, Krub, Pridi, Chonburi, Itim) — see
// docs/plans/reports/2026-09-12-A3-code-audit.md §A3.4.
export default function VideoEditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SubtitleFonts />
      {children}
    </>
  );
}
