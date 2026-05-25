import { DashboardLayout } from "@/components/layout/dashboard-layout";

/**
 * Shared shell for all (dashboard) routes.
 * Mounting DashboardLayout here (instead of inside each page) means
 * TopNav + Sidebar stay mounted across navigations — no flicker,
 * no remount, sidebar position is preserved.
 *
 * Pages should render their content directly without wrapping it
 * in <DashboardLayout> again.
 */
export default function DashboardRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
