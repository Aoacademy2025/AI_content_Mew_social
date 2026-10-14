import { redirect, notFound } from "next/navigation";
import { quoteBrowserOwner } from "@/lib/mcp/video-quote-browser-auth.server";
import { getVideoQuoteReview } from "@/lib/mcp/video-quote.server";
import { QuoteConfirmation } from "./quote-confirmation";

export const dynamic = "force-dynamic";
export default async function QuoteConfirmationPage({ params }: { params: Promise<{ quoteId: string }> }) {
  const { quoteId } = await params;
  const userId = await quoteBrowserOwner();
  if (!userId) redirect(`/login?redirect_url=${encodeURIComponent(`/mcp/confirm/${quoteId}`)}`);
  const review = await getVideoQuoteReview(userId, quoteId);
  if (!review) notFound();
  return <QuoteConfirmation {...review} />;
}
