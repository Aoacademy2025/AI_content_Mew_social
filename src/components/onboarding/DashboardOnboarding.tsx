"use client";

import { useEffect, useState, useCallback } from "react";
import { KeySetupChecklist } from "./KeySetupChecklist";
import { KeyOnboardingWizard } from "./KeyOnboardingWizard";
import { ModelExplainerPanel } from "./ModelExplainerPanel";
import { computeKeyStatus, type KeyStatus } from "@/lib/key-tiers";

export function DashboardOnboarding() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [managed, setManaged] = useState(false);
  const [minuteQuota, setMinuteQuota] = useState(false);
  const [minutesForPlan, setMinutesForPlan] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/user/api-keys/status", { cache: "no-store" });
      if (!res.ok) return; // fail-open
      const data = await res.json();
      const st = computeKeyStatus(data);
      setStatus(st);
      setManaged(!!data.managed);
      setMinuteQuota(!!data.minuteQuota);
      // เด้ง wizard อัตโนมัติเฉพาะครั้งแรก: Tier-1 ยังไม่ครบ และยังไม่เคยกดข้าม
      if (!st.tier1Complete && !data.onboardingDismissed) setWizardOpen(true);
    } catch { /* fail-open */ }
  }, []);

  // Fetch plan minutes separately from /api/user/me (fail-open — only used for display)
  useEffect(() => {
    fetch("/api/user/me")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        // map plan → minutes (matches plan-limits.ts)
        const plan: string = d.plan ?? "FREE";
        // ⚠️ MUST stay in sync with minutesPerMonthForPlan in src/lib/plan-limits.ts (authoritative source).
        const planMinutes: Record<string, number> = { FREE: 5, PRO: 80, BUSINESS: 150 };
        setMinutesForPlan(planMinutes[plan] ?? null);
      })
      .catch(() => { /* fail-open */ });
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!status) return null;
  return (
    <>
      <ModelExplainerPanel managed={managed} minuteQuota={minuteQuota} minutesForPlan={minutesForPlan} />
      <KeySetupChecklist status={status} onSetup={() => setWizardOpen(true)} managed={managed} />
      {wizardOpen && (
        <KeyOnboardingWizard
          open={true}
          onClose={() => setWizardOpen(false)}
          onComplete={() => { setWizardOpen(false); void load(); }}
          managed={managed}
        />
      )}
    </>
  );
}
