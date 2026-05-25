import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function FallbackLoading() {
  return <PageSkeleton variant="cards" count={3} />;
}
