"use client";

import { useEffect, useState, useCallback } from "react";
import { KeySetupChecklist } from "./KeySetupChecklist";
import { KeyOnboardingWizard } from "./KeyOnboardingWizard";
import { ModelExplainerPanel } from "./ModelExplainerPanel";
import { computeKeyStatus, type KeyStatus } from "@/lib/key-tiers";
import { fetchMe } from "@/lib/use-me";
import { isManagedStockClientEnabled } from "@/lib/managed-stock";

/**
 * @param firstClipPath One number before the first clip (#304): the day-one
 * dashboard states the minute allowance in its own hero line, so the model
 * explainer (minutes + credit top-up) is not mounted for that cohort.
 */
export function DashboardOnboarding({ firstClipPath = false }: { firstClipPath?: boolean }) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [managed, setManaged] = useState(false);
  // MANAGED_STOCK (#297): build-baked mirror first (so the very first paint is
  // already right), then confirmed by the server flag in the status payload.
  const [managedStock, setManagedStock] = useState(isManagedStockClientEnabled());
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
      const stockManaged = !!data.managedStock || isManagedStockClientEnabled();
      setManagedStock(stockManaged);
      // เด้ง wizard อัตโนมัติเฉพาะครั้งแรก: Tier-1 ยังไม่ครบ และยังไม่เคยกดข้าม
      // MANAGED_STOCK on (#297): ไม่มี key ตัวไหนเป็น blocker วันแรกอีกแล้ว → ไม่เด้ง
      // (wizard ยังเปิดเองได้จาก Settings และจากปุ่ม "ตั้งค่า" ของ checklist)
      if (!st.tier1Complete && !data.onboardingDismissed && !stockManaged) setWizardOpen(true);
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
        <ModelExplainerPanel managed={managed} minuteQuota={minuteQuota} minutesForPlan={minutesForPlan} managedStock={managedStock} />
      )}
      <KeySetupChecklist status={status} onSetup={() => setWizardOpen(true)} managed={managed} managedStock={managedStock} />
      {wizardOpen && (
        <KeyOnboardingWizard
          open={true}
          onClose={() => setWizardOpen(false)}
          onComplete={() => { setWizardOpen(false); void load(); }}
          managed={managed}
          managedStock={managedStock}
        />
      )}
    </>
  );
}
