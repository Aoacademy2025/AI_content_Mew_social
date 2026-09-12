import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";
import { resolveBrandLibraryAccess } from "@/lib/brand-visual-rollout.server";
import { BrandVisualLockedPreview } from "./_components/BrandVisualLockedPreview";
import { SubtitleFonts } from "@/components/subtitle-fonts";

export default async function BrandsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?redirect_url=/brands");
  // ADR 0059: the Brand Library is open to every plan. Only the master switch and
  // a suspension close the page; the paid/rollout gates live on image actions.
  const library = await resolveBrandLibraryAccess(user);
  if (!library.canUse) {
    return <BrandVisualLockedPreview reason={library.reason === "suspended" ? "suspended" : "feature_off"} />;
  }
  // Style-pack sample cards (StylePackPicker.tsx, via style-pack-catalog.ts)
  // render subtitle preview text in Kanit/Sarabun/Prompt — see
  // docs/plans/reports/2026-09-12-A3-code-audit.md §A3.4.
  return (
    <>
      <SubtitleFonts />
      {children}
    </>
  );
}
