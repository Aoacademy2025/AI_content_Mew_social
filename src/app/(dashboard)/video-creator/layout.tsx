import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";
import { SubtitleFonts } from "@/components/subtitle-fonts";

export default async function VideoCreatorLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") redirect("/dashboard");
  return (
    <>
      <SubtitleFonts />
      {children}
    </>
  );
}
