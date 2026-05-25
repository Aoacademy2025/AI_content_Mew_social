import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function AdminCouponsLoading() {
  return <PageSkeleton title="คูปอง" subtitle="จัดการคูปองส่วนลด" variant="list" count={5} />;
}
