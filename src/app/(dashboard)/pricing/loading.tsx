import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function PricingLoading() {
  return <PageSkeleton title="Pricing" subtitle="เลือกแผนที่เหมาะกับคุณ" variant="cards" count={3} />;
}
