import { getCurrentUser } from "@/lib/clerk-auth";
import { isInternalAiTester } from "@/lib/internal-ai-access";
import { notFound } from "next/navigation";

export default async function AiStudioPrivateBetaLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  if (!user || !isInternalAiTester(user)) notFound();

  return children;
}
