import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function AdminUsersLoading() {
  return <PageSkeleton title="จัดการผู้ใช้งาน" subtitle="ผู้ใช้งานทั้งหมดในระบบ" variant="list" count={6} />;
}
