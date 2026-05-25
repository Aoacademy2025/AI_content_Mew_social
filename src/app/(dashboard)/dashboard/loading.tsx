import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function DashboardLoading() {
  return <PageSkeleton title="Dashboard" subtitle="ภาพรวมการใช้งานของคุณ" variant="cards" count={3} />;
}
