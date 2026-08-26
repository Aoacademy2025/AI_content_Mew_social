"use client";

import { useEffect, useState, useCallback } from "react";
import { KeySetupChecklist } from "./KeySetupChecklist";
import { KeyOnboardingWizard } from "./KeyOnboardingWizard";
import { ModelExplainerPanel } from "./ModelExplainerPanel";
import { computeKeyStatus, type KeyStatus } from "@/lib/key-tiers";
import { fetchMe } from "@/lib/use-me";

/**
 * @param firstClipPath One number before the first clip (#304): the day-one
 * dashboard states the minute allowance in its own hero line, so the model
 * explainer (minutes + credit top-up) is not mounted for that cohort.
 */
export function DashboardOnboarding({ firstClipPath = false }: { firstClipPath?: boolean }) {
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

  // Real per-user allowance straight from /api/user/me (fail-open — display only).
  // This used to be a hardcoded plan→minutes map, so every trial account was told
  // "80 นาที/เดือน" while it actually held 15 (#304).
  useEffect(() => {
    fetchMe()
      .then(d => {
        if (!d) return;
        setMinutesForPlan(typeof d.minutesLimit === "number" ? d.minutesLimit : null);
      })
      .catch(() => { /* fail-open */ });
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!status) return null;
  return (
    <>
      {!firstClipPath && (
        <ModelExplainerPanel managed={managed} minuteQuota={minuteQuota} minutesForPlan={minutesForPlan} />
      )}
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
