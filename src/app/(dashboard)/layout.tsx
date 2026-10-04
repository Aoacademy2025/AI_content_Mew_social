import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { promptpayMonthlyEnabled } from "@/lib/promptpay-monthly";

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
  // ADR 0066: PROMPTPAY_MONTHLY is a server-only flag (no NEXT_PUBLIC_ twin) — this
  // server layout is the one place that reads it for the dashboard chrome, and
  // passes it down as a prop (the PRESERVE_TRIAL_ON_CONVERT pattern).
  return (
    <DashboardLayout promptpayMonthly={promptpayMonthlyEnabled()}>
      {children}
    </DashboardLayout>
  );
}
