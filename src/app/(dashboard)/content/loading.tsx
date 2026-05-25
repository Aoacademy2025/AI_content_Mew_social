import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function ContentLoading() {
  return <PageSkeleton title="Content" subtitle="คอนเทนต์ทั้งหมดของคุณ" variant="list" count={5} />;
}
