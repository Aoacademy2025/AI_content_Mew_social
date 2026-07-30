"use client";

// /hero-script — "เขียนสคริปต์ AI" page shell.
//
// Task 1 shipped the Setup rail (BrandProfilePanel: profile picker + duration
// + create/edit dialog + Niche Drill-down). Task 2 adds steps 2-3 (หัวข้อ →
// เลือก Hook). Later Hero Script tasks mount the remaining stepper sections
// (สคริปต์เต็ม → ส่งไปตัดต่อ, plus the "สคริปต์ของฉัน" history list) below/
// alongside this rail — the lifted `selectedProfileId`/`durationSec`/`topic`/
// `selectedHook` state here is what they consume.

import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/use-me";
import {
  BrandProfilePanel,
  type DurationSec,
} from "./_components/BrandProfilePanel";
import { TopicStep } from "./_components/TopicStep";
import { HookStep, type HookChoice } from "./_components/HookStep";

const VIOLET_LIGHT = "#B9A6FF";

export default function HeroScriptPage() {
  const [plan, setPlan] = useState("FREE");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState<DurationSec>(60);
  const [topic, setTopic] = useState("");
  const [selectedHook, setSelectedHook] = useState<HookChoice | null>(null);

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

          {/* ── Step 2: หัวข้อ ── */}
          <TopicStep
            selectedProfileId={selectedProfileId}
            topic={topic}
            onTopicChange={setTopic}
          />

          {/* ── Step 3: เลือก Hook ── */}
          <HookStep
            topic={topic}
            durationSec={durationSec}
            selectedProfileId={selectedProfileId}
            selectedHook={selectedHook}
            onSelectedHookChange={setSelectedHook}
          />

          {/* Steps 4-5 (สคริปต์เต็ม / ส่งไปตัดต่อ) and the "สคริปต์ของฉัน"
              history list mount here in later Hero Script tasks. */}
        </div>
      </div>
    </div>
  );
}
