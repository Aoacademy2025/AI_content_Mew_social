import { SubtitleFonts } from "@/components/subtitle-fonts";

// dashboard/page.tsx renders headline numbers in Kanit, and the first-clip
// hero (components/dashboard/first-clip-hero.tsx) renders its headings in
// Bai Jamjuree — neither is self-hosted outside the v2 editor bundle. See
// docs/plans/reports/2026-09-12-A3-code-audit.md §A3.4.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SubtitleFonts />
      {children}
    </>
  );
}
