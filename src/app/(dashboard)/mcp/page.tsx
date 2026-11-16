"use client";

import { useEffect, useState } from "react";
import { Terminal } from "lucide-react";
import { fetchMe } from "@/lib/use-me";
import { McpAccessSettings } from "@/components/settings/mcp-access-settings";

export default function McpCreatorPackPage() {
  const [meUser, setMeUser] = useState<Awaited<ReturnType<typeof fetchMe>>>(null);
  useEffect(() => {
    fetchMe().then((u) => { if (u) setMeUser(u); }).catch(() => {});
  }, []);
  const effectivePlan = meUser?.effectivePlan ?? meUser?.plan ?? "FREE";
  const isPaidPlan = effectivePlan === "PRO" || effectivePlan === "BUSINESS";

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 mx-auto max-w-4xl px-4 md:px-6 pt-4 pb-12 space-y-6">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300">
            HERO AI · Agent MCP & Creator Prompt Pack
          </p>
          <h1
            className="text-3xl md:text-4xl font-bold tracking-tight"
            style={{ fontFamily: "var(--font-kanit), Kanit, sans-serif", color: "var(--ui-text-primary)" }}
          >
            ต่อ AI Agent (MCP) & Creator Prompt Pack
          </h1>
          <p className="text-sm md:text-base" style={{ color: "var(--ui-text-secondary)" }}>
            เชื่อมต่อ Claude Desktop, Cursor หรือ Claude Code ในคลิกเดียว พร้อมแม่แบบคำสั่งสร้างคลิปสั้นภาษาไทย 5 สไตล์
          </p>
        </div>

        <div className="ve-card rounded-xl p-6 md:p-7">
          <div className="flex items-center gap-3 mb-6 pb-5 border-b border-white/5">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ background: "hsl(var(--accent-primary) / 0.1)", border: "1px solid hsl(var(--accent-primary) / 0.2)" }}
            >
              <Terminal className="h-4 w-4" style={{ color: "hsl(var(--accent-primary))" }} strokeWidth={2.25} />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
                1-Click MCP Setup & Prompt Templates
              </h2>
              <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                สร้าง Token คัดลอกการตั้งค่า และก๊อปปี้ Prompt แม่แบบไปวางในแชท Agent ได้ทันที
              </p>
            </div>
          </div>

          <McpAccessSettings allowed={isPaidPlan} />
        </div>
      </div>
    </div>
  );
}
