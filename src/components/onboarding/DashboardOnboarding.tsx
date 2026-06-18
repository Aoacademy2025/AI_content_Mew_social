"use client";

import { useEffect, useState } from "react";
import { KeySetupChecklist } from "./KeySetupChecklist";
import { KeyOnboardingWizard } from "./KeyOnboardingWizard";
import { computeKeyStatus, type KeyStatus } from "@/lib/key-tiers";

export function DashboardOnboarding() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/user/api-keys/status", { cache: "no-store" });
      if (!res.ok) return; // fail-open
      const data = await res.json();
      const st = computeKeyStatus(data);
      setStatus(st);
      // เด้ง wizard อัตโนมัติเฉพาะครั้งแรก: Tier-1 ยังไม่ครบ และยังไม่เคยกดข้าม
      if (!st.tier1Complete && !data.onboardingDismissed) setWizardOpen(true);
    } catch { /* fail-open */ }
  }

  useEffect(() => { void load(); }, []);

  if (!status) return null;
  return (
    <>
      <KeySetupChecklist status={status} onSetup={() => setWizardOpen(true)} />
      {wizardOpen && (
        <KeyOnboardingWizard
          open={true}
          onClose={() => setWizardOpen(false)}
          onComplete={() => { setWizardOpen(false); void load(); }}
        />
      )}
    </>
  );
}
