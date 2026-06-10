import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/clerk-auth";

export default async function VideoCreatorLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") redirect("/dashboard");
  return <>{children}</>;
}
