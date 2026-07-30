"use client";

// /hero-script — "เขียนสคริปต์ AI" page shell.
//
// Task 1 ships the Setup rail (BrandProfilePanel: profile picker + duration +
// create/edit dialog + Niche Drill-down). Later Hero Script tasks mount the
// remaining stepper sections (หัวข้อ → เลือก Hook → สคริปต์เต็ม → ส่งไปตัดต่อ,
// plus the "สคริปต์ของฉัน" history list) below/alongside this rail — the
// lifted `selectedProfileId`/`durationSec` state here is what they consume.

import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/use-me";
import {
  BrandProfilePanel,
  type DurationSec,
} from "./_components/BrandProfilePanel";

const VIOLET_LIGHT = "#B9A6FF";

export default function HeroScriptPage() {
  const [plan, setPlan] = useState("FREE");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<DurationSec>(60);

  useEffect(() => {
    fetchMe().then((me) => {
      if (me) setPlan((me.effectivePlan ?? me.plan) || "FREE");
    });
  }, []);

  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <div className="space-y-6">
          {/* ── Page header ── */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: VIOLET_LIGHT }}>
              Hero Script
            </p>
            <h1
              className="text-2xl font-bold tracking-tight md:text-3xl"
              style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}
            >
              เขียนสคริปต์ AI
            </h1>
          </div>

          {/* ── Step 1: Setup rail ── */}
          <BrandProfilePanel
            plan={plan}
            selectedProfileId={selectedProfileId}
            onSelectedProfileIdChange={setSelectedProfileId}
            durationSec={durationSec}
            onDurationSecChange={setDurationSec}
          />

          {/* Steps 2-5 (หัวข้อ / เลือก Hook / สคริปต์เต็ม / ส่งไปตัดต่อ) and the
              "สคริปต์ของฉัน" history list mount here in later Hero Script tasks. */}
        </div>
      </div>
    </div>
  );
}
