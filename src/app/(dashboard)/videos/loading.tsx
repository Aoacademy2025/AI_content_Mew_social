import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function VideosLoading() {
  return <PageSkeleton title="Gallery" subtitle="วิดีโอทั้งหมดของคุณ" variant="grid" count={8} />;
}
