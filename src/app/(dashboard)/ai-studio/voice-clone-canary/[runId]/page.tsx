import ReviewClient from "./ReviewClient";

export default async function HeroVoiceCanaryReviewPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <ReviewClient runId={runId} />;
}
