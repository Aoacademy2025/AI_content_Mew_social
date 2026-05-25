import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function SettingsLoading() {
  return <PageSkeleton title="Settings" subtitle="จัดการบัญชีและการตั้งค่า" variant="form" count={4} />;
}
