"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { trackEvent } from "@/lib/client-telemetry";
import {
  buildReturnLoopAction,
  selectReturnLoopProject,
  type ReturnLoopProject,
} from "@/lib/return-loop";

const VIOLET = "#8B5CF6";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_GRADIENT = "linear-gradient(180deg,#8B66F8,#6C4CF4)";

function returnLoopProject(value: unknown): ReturnLoopProject | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ReturnLoopProject>;
  if (typeof row.id !== "string" || !row.id.trim() || typeof row.status !== "string") return null;
  return {
    id: row.id,
    title: typeof row.title === "string" ? row.title : "New Project",
    status: row.status,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
    lastOpenedAt: typeof row.lastOpenedAt === "string" ? row.lastOpenedAt : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
  };
}

function projectDate(project: ReturnLoopProject): string | null {
  const value = project.lastOpenedAt || project.updatedAt || project.createdAt;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function ProgressRail({ step, finished }: { step: 1 | 2 | 3; finished: boolean }) {
  const labels = ["ตั้งค่างาน", "สร้างวิดีโอ", "ส่งออก"] as const;
  return (
    <ol
      className="mt-5 grid grid-cols-3 gap-2"
      aria-label={finished ? "งานล่าสุดส่งออกแล้ว" : `อยู่ขั้นที่ ${step} จาก 3`}
    >
      {labels.map((label, index) => {
        const current = index + 1;
        const reached = current <= step;
        const done = finished || current < step;
        return (
          <li key={label} className="min-w-0">
            <span
              className="mb-2 block h-1 rounded-full"
              style={{ background: reached ? VIOLET : "var(--ui-divider)" }}
            />
            <span
              className="flex items-center gap-1 text-[10px] font-medium"
              style={{ color: reached ? "var(--ui-text-secondary)" : "var(--ui-text-muted)" }}
            >
              {done && <Check className="h-3 w-3 shrink-0" style={{ color: VIOLET_LIGHT }} aria-hidden="true" />}
              <span className="truncate">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ReturnLoopCard() {
  const [project, setProject] = useState<ReturnLoopProject | null>(null);
  const trackedViewRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void authenticatedFetch("/api/editor-projects", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json().catch(() => null);
      const rows: unknown[] = Array.isArray(payload?.projects) ? payload.projects : [];
      const projects = rows
        .map(returnLoopProject)
        .filter((item): item is ReturnLoopProject => item !== null);
      setProject(selectReturnLoopProject(projects));
    }).catch(() => {
      // This is a supplementary re-entry path. Keep the rest of Dashboard usable
      // when the project list is temporarily unavailable.
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!project || trackedViewRef.current === project.id) return;
    trackedViewRef.current = project.id;
    const action = buildReturnLoopAction(project);
    trackEvent("return_loop_viewed", {
      properties: { projectStatus: project.status, nextStep: action.step },
    });
  }, [project]);

  if (!project) return null;

  const action = buildReturnLoopAction(project);
  const openedAt = projectDate(project);
  const title = project.title.trim() && project.title !== "New Project"
    ? project.title.trim()
    : "โปรเจกต์วิดีโอล่าสุด";
  const finished = project.status === "exported";

  function trackClick(target: "primary" | "previous") {
    trackEvent("return_loop_clicked", {
      properties: {
        target,
        projectStatus: project!.status,
        nextStep: action.step,
      },
    });
  }

  return (
    <section
      className="ve-rise ve-card mb-6 overflow-hidden rounded-2xl"
      style={{ animationDelay: "110ms" }}
      aria-labelledby="return-loop-heading"
    >
      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-10">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-semibold uppercase tracking-[0.14em]">
            <span className="inline-flex items-center gap-1.5" style={{ color: VIOLET_LIGHT }}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              ทำต่อจากล่าสุด
            </span>
            <span aria-hidden="true" style={{ color: "var(--ui-divider)" }}>•</span>
            <span style={{ color: "var(--ui-text-muted)" }}>{action.statusLabel}</span>
            {openedAt && (
              <>
                <span aria-hidden="true" style={{ color: "var(--ui-divider)" }}>•</span>
                <span className="normal-case tracking-normal" style={{ color: "var(--ui-text-muted)" }}>{openedAt}</span>
              </>
            )}
          </div>

          <h2
            id="return-loop-heading"
            className="truncate text-[20px] font-semibold leading-tight tracking-tight sm:text-[22px]"
            style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}
            title={title}
          >
            {title}
          </h2>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
            {action.nextAction}
          </p>

          <ProgressRail step={action.step} finished={finished} />
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center lg:min-w-[190px] lg:flex-col lg:items-stretch">
          <Link
            href={action.href}
            prefetch
            onClick={() => trackClick("primary")}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-3 text-[13px] font-bold text-white transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
            style={{ background: VIOLET_GRADIENT }}
          >
            {action.ctaLabel}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          {action.secondaryHref && action.secondaryLabel && (
            <Link
              href={action.secondaryHref}
              prefetch
              onClick={() => trackClick("previous")}
              className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2 text-[12px] font-semibold transition-colors hover:bg-violet-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
              style={{ color: VIOLET_LIGHT }}
            >
              {action.secondaryLabel}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
