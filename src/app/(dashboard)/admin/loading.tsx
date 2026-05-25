import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function AdminLoading() {
  return <PageSkeleton title="Admin" subtitle="ภาพรวมระบบ" variant="cards" count={4} />;
}
