"use client";

import { useState } from "react";
import { BookOpen, Film, Wand2, Captions, Settings2, Play, Layers, User, Key, AlertTriangle, Info, CheckCircle2, RefreshCw } from "lucide-react";

/* ═══════════════════════════════════════════════════
   SCI-FI / NEON COMPONENTS
═══════════════════════════════════════════════════ */

// Card with animated neon border + corner brackets + holographic header strip
function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <section className="doc-card group relative overflow-hidden rounded-2xl">
      {/* Animated neon border */}
      <div aria-hidden className="doc-card-border absolute inset-0 rounded-2xl pointer-events-none" />

      {/* Corner brackets — cyberpunk feel */}
      <CornerBrackets />

      {/* Header strip with scan line */}
      <div className="relative px-6 pt-5 pb-4">
        <div className="absolute top-0 left-0 right-0 h-px doc-scanline" aria-hidden />
        <div className="flex items-center gap-3">
          <div className="doc-icon-frame relative flex h-10 w-10 items-center justify-center rounded-xl shrink-0">
            <Icon className="h-4.5 w-4.5 text-cyan-300 relative z-10" strokeWidth={2.25} />
          </div>
          <h2 className="text-[17px] font-bold tracking-tight text-white">{title}</h2>
        </div>
      </div>

      {/* Divider with gradient fade */}
      <div className="h-px mx-6 bg-linear-to-r from-transparent via-cyan-500/25 to-transparent" />

      <div className="relative px-6 py-5 space-y-3 text-sm text-white/70 leading-relaxed">{children}</div>
    </section>
  );
}

// Hexagon-ish badge for steps — outlined with glow
function Step({ num, title, children }: { num: string | number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="doc-step-badge relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[13px] font-black text-cyan-200">
        <span className="relative z-10">{num}</span>
      </div>
      <div className="flex-1 pt-1">
        <h3 className="text-[14px] font-bold text-white mb-1.5 tracking-tight">{title}</h3>
        <div className="text-[13px] text-white/65 space-y-1.5 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

// Pipeline step with neon connector
function PipelineRow({ num, name, desc }: { num: number; name: string; desc: string }) {
  return (
    <div className="relative flex gap-3 items-start py-3 group">
      {/* Vertical connector */}
      <div aria-hidden className="absolute left-[15px] top-9 bottom-0 w-px bg-linear-to-b from-cyan-500/40 via-cyan-500/15 to-transparent last:hidden" />
      <div className="relative flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg font-mono text-[10px] font-black text-cyan-300"
        style={{
          background: "linear-gradient(135deg, hsl(190 100% 50% / 0.18), hsl(230 100% 55% / 0.10))",
          border: "1px solid hsl(190 100% 50% / 0.45)",
          boxShadow: "0 0 12px hsl(190 100% 50% / 0.25), inset 0 0 8px hsl(190 100% 50% / 0.15)",
        }}>
        {String(num).padStart(2, "0")}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-[13.5px] font-bold text-white tracking-tight">{name}</p>
        <p className="text-[12px] text-white/50 mt-0.5 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

// API key row — neon panel with status badge
function ApiRow({ name, required, desc, link, linkLabel }: { name: string; required: boolean; desc: string; link?: string; linkLabel?: string }) {
  return (
    <div className="doc-panel relative overflow-hidden rounded-xl px-4 py-3.5 transition-all hover:bg-white/[0.03]">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <p className="text-[13.5px] font-bold text-white tracking-tight">{name}</p>
        <span
          className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md shrink-0 ${
            required
              ? "text-red-300 bg-red-500/10 border border-red-500/30 shadow-[0_0_8px_hsl(0_70%_50%/0.2)]"
              : "text-white/50 bg-white/5 border border-white/15"
          }`}
        >
          {required ? "Required" : "Optional"}
        </span>
      </div>
      <p className="text-[12px] text-white/55 leading-relaxed">{desc}</p>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer"
          className="group/link inline-flex items-center gap-1 mt-2.5 text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 transition-colors">
          <span className="transition-transform group-hover/link:translate-x-0.5">→</span>
          <span className="underline-offset-2 group-hover/link:underline">{linkLabel ?? link}</span>
        </a>
      )}
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] overflow-hidden"
      style={{
        background: "linear-gradient(135deg, hsl(35 100% 50% / 0.10), hsl(15 100% 50% / 0.05))",
        border: "1px solid hsl(35 100% 50% / 0.35)",
        boxShadow: "0 0 16px hsl(35 100% 50% / 0.10), inset 0 1px 0 hsl(35 100% 70% / 0.08)",
      }}>
      <AlertTriangle className="h-4 w-4 text-amber-300 shrink-0 mt-px drop-shadow-[0_0_4px_hsl(35_100%_50%/0.5)]" />
      <span className="text-amber-100/85 leading-relaxed">{children}</span>
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] overflow-hidden"
      style={{
        background: "linear-gradient(135deg, hsl(190 100% 50% / 0.10), hsl(220 100% 55% / 0.05))",
        border: "1px solid hsl(190 100% 50% / 0.30)",
        boxShadow: "0 0 16px hsl(190 100% 50% / 0.12), inset 0 1px 0 hsl(190 100% 70% / 0.08)",
      }}>
      <Info className="h-4 w-4 text-cyan-300 shrink-0 mt-px drop-shadow-[0_0_4px_hsl(190_100%_50%/0.6)]" />
      <span className="text-cyan-100/85 leading-relaxed">{children}</span>
    </div>
  );
}

function ErrBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="doc-panel relative overflow-hidden rounded-xl px-4 py-3 group hover:bg-white/[0.03] transition-all">
      <div className="flex items-center gap-2 mb-1.5">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-300 shrink-0 drop-shadow-[0_0_3px_hsl(35_100%_50%/0.4)]" />
        <p className="text-white font-bold text-[13px] tracking-tight">{title}</p>
      </div>
      <div className="text-[12px] text-white/55 leading-relaxed pl-5">{children}</div>
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 items-start">
      <span className="relative mt-0.5 shrink-0">
        <CheckCircle2 className="h-4 w-4 text-cyan-300 drop-shadow-[0_0_3px_hsl(190_100%_50%/0.5)]" strokeWidth={2.5} />
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}

// Cyberpunk corner brackets for cards
function CornerBrackets() {
  const C = "absolute h-3 w-3 border-cyan-400/40 pointer-events-none";
  return (
    <>
      <span aria-hidden className={`${C} top-2 left-2 border-t border-l rounded-tl-sm`} />
      <span aria-hidden className={`${C} top-2 right-2 border-t border-r rounded-tr-sm`} />
      <span aria-hidden className={`${C} bottom-2 left-2 border-b border-l rounded-bl-sm`} />
      <span aria-hidden className={`${C} bottom-2 right-2 border-b border-r rounded-br-sm`} />
    </>
  );
}

type Tab = "api" | "video" | "avatar";

export default function DocsPage() {
  const [tab, setTab] = useState<Tab>("api");

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "api", label: "ตั้งค่า API", icon: Key },
    { id: "video", label: "Video Editor", icon: Film },
    { id: "avatar", label: "+ Avatar", icon: User },
  ];

  const activeTab = tabs.find(t => t.id === tab) ?? tabs[0];

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      {/* ── Full-page sci-fi backdrop — sticks to viewport while user scrolls ── */}
      <div aria-hidden className="doc-grid-bg pointer-events-none fixed inset-0 z-0" />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="doc-orb-1 absolute -top-32 left-[15%] h-96 w-96 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(190 100% 50%), transparent)" }} />
        <div className="doc-orb-2 absolute -top-20 right-[15%] h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(252 80% 60%), transparent)" }} />
        <div className="doc-orb-3 absolute top-[35%] left-1/2 -translate-x-1/2 h-72 w-72 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(285 70% 60%), transparent)" }} />
        <div className="doc-orb-1 absolute bottom-[20%] right-[10%] h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(190 100% 50%), transparent)", animationDelay: "-7s" }} />
        <div className="doc-orb-2 absolute bottom-[5%] left-[10%] h-72 w-72 rounded-full blur-3xl"
          style={{ background: "radial-gradient(closest-side, hsl(252 80% 60%), transparent)", animationDelay: "-12s" }} />
      </div>

      {/* ── Premium animations & decorations ──────────────────────────── */}
      <style jsx global>{`
        @keyframes doc-orb-1 {
          0%,100% { transform: translate(0,0) scale(1); opacity: 0.30; }
          33%     { transform: translate(40px,30px) scale(1.15); opacity: 0.42; }
          66%     { transform: translate(-30px,50px) scale(0.92); opacity: 0.25; }
        }
        @keyframes doc-orb-2 {
          0%,100% { transform: translate(0,0) scale(1); opacity: 0.22; }
          50%     { transform: translate(-50px,40px) scale(1.2); opacity: 0.38; }
        }
        @keyframes doc-orb-3 {
          0%,100% { transform: translate(0,0) scale(1); opacity: 0.18; }
          50%     { transform: translate(30px,-40px) scale(1.1); opacity: 0.32; }
        }
        @keyframes doc-shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes doc-glow-pulse {
          0%,100% { box-shadow: 0 0 0 1px hsl(190 100% 50% / 0.15) inset, 0 4px 18px hsl(190 100% 40% / 0.18); }
          50%     { box-shadow: 0 0 0 1px hsl(190 100% 60% / 0.35) inset, 0 6px 28px hsl(190 100% 50% / 0.32); }
        }
        @keyframes doc-fade-up {
          0%   { opacity: 0; transform: translateY(14px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes doc-fade-in {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes doc-grid-drift {
          0%   { background-position: 0 0; }
          100% { background-position: 40px 40px; }
        }
        @keyframes doc-chip-pulse {
          0%,100% { opacity: 1; }
          50%     { opacity: 0.55; }
        }
        .doc-orb-1 { animation: doc-orb-1 22s cubic-bezier(.45,.05,.55,.95) infinite; }
        .doc-orb-2 { animation: doc-orb-2 28s cubic-bezier(.45,.05,.55,.95) infinite; }
        .doc-orb-3 { animation: doc-orb-3 19s cubic-bezier(.45,.05,.55,.95) infinite; }
        .doc-shimmer {
          background-image: linear-gradient(110deg, transparent 35%, hsl(0 0% 100% / 0.08) 50%, transparent 65%);
          background-size: 200% 100%;
          animation: doc-shimmer 6s ease-in-out infinite;
        }
        .doc-tab-active { animation: doc-glow-pulse 3.2s ease-in-out infinite; }
        .doc-fade-up { animation: doc-fade-up 0.6s cubic-bezier(.2,.65,.3,1) both; }
        .doc-fade-in { animation: doc-fade-in 0.5s ease-out both; }
        .doc-grid-bg {
          background-image:
            linear-gradient(hsl(0 0% 100% / 0.025) 1px, transparent 1px),
            linear-gradient(90deg, hsl(0 0% 100% / 0.025) 1px, transparent 1px);
          background-size: 40px 40px;
          animation: doc-grid-drift 30s linear infinite;
          mask-image: linear-gradient(to bottom, black 0%, black 60%, hsl(0 0% 0% / 0.7) 100%);
        }
        .doc-chip-dot { animation: doc-chip-pulse 2s ease-in-out infinite; }

        /* ── Sci-fi card with animated neon border ─────────────────── */
        @keyframes doc-border-spin {
          0%   { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        @keyframes doc-scanline-sweep {
          0%   { transform: translateX(-100%); opacity: 0; }
          50%  { opacity: 1; }
          100% { transform: translateX(100%); opacity: 0; }
        }
        @keyframes doc-icon-pulse {
          0%,100% { box-shadow: 0 0 0 1px hsl(190 100% 50% / 0.35) inset, 0 0 12px hsl(190 100% 50% / 0.20); }
          50%     { box-shadow: 0 0 0 1px hsl(190 100% 60% / 0.55) inset, 0 0 22px hsl(190 100% 50% / 0.40); }
        }
        @keyframes doc-step-glow {
          0%,100% { box-shadow: 0 0 8px hsl(190 100% 50% / 0.25), inset 0 0 0 1px hsl(190 100% 50% / 0.40); }
          50%     { box-shadow: 0 0 16px hsl(190 100% 50% / 0.45), inset 0 0 0 1px hsl(190 100% 60% / 0.60); }
        }

        /* Section card */
        .doc-card {
          background:
            radial-gradient(120% 80% at 0% 0%, hsl(190 100% 50% / 0.04), transparent 50%),
            radial-gradient(120% 80% at 100% 100%, hsl(252 80% 60% / 0.04), transparent 50%),
            hsl(220 30% 6% / 0.85);
          backdrop-filter: blur(12px);
          box-shadow:
            0 1px 0 hsl(0 0% 100% / 0.04) inset,
            0 24px 48px hsl(0 0% 0% / 0.35);
        }
        .doc-card-border {
          padding: 1px;
          background: linear-gradient(110deg,
            hsl(0 0% 100% / 0.04) 0%,
            hsl(190 100% 50% / 0.45) 20%,
            hsl(252 80% 60% / 0.35) 40%,
            hsl(0 0% 100% / 0.04) 60%,
            hsl(190 100% 50% / 0.35) 80%,
            hsl(0 0% 100% / 0.04) 100%
          );
          background-size: 200% 100%;
          animation: doc-border-spin 8s linear infinite;
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          -webkit-mask-composite: xor;
                  mask-composite: exclude;
        }
        .doc-card:hover .doc-card-border { animation-duration: 4s; }

        /* Section header scanline */
        .doc-scanline {
          background: linear-gradient(90deg, transparent, hsl(190 100% 60% / 0.85), transparent);
          animation: doc-scanline-sweep 5s ease-in-out infinite;
        }

        /* Icon frame inside card header */
        .doc-icon-frame {
          background: linear-gradient(135deg, hsl(190 100% 45% / 0.18), hsl(230 100% 55% / 0.10));
          border: 1px solid hsl(190 100% 50% / 0.40);
          animation: doc-icon-pulse 3.6s ease-in-out infinite;
        }

        /* Step badge */
        .doc-step-badge {
          background: linear-gradient(135deg, hsl(190 100% 45% / 0.15), hsl(252 80% 60% / 0.10));
          border: 1px solid hsl(190 100% 50% / 0.40);
          animation: doc-step-glow 3s ease-in-out infinite;
        }

        /* Panel — used by ApiRow / ErrBox */
        .doc-panel {
          background: hsl(220 30% 8% / 0.55);
          border: 1px solid hsl(0 0% 100% / 0.06);
          box-shadow: inset 0 1px 0 hsl(0 0% 100% / 0.03);
        }

        @media (prefers-reduced-motion: reduce) {
          .doc-orb-1, .doc-orb-2, .doc-orb-3, .doc-shimmer, .doc-tab-active,
          .doc-fade-up, .doc-fade-in, .doc-grid-bg, .doc-chip-dot,
          .doc-card-border, .doc-scanline, .doc-icon-frame, .doc-step-badge {
            animation: none !important;
          }
        }
      `}</style>

      {/* ── Premium hero — content sits on top of the fixed backdrop above ── */}
      <div className="relative z-10">
        <div className="relative mx-auto max-w-4xl px-4 pt-3 pb-5 md:px-6 md:pt-4">
          {/* Eyebrow */}
          <div className="doc-fade-up flex items-center gap-2 mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300/70"
            style={{ animationDelay: "0ms" }}>
            <span className="h-px w-6 bg-linear-to-r from-transparent to-cyan-400/50" />
            Documentation
            <span className="doc-chip-dot h-1 w-1 rounded-full bg-cyan-400" />
            studio.heroaiengine.com
          </div>

          {/* Title with shimmer on gradient text */}
          <h1 className="doc-fade-up text-4xl md:text-5xl font-black tracking-tight text-white leading-tight"
            style={{ animationDelay: "60ms" }}>
            คู่มือการใช้งาน
            <span className="relative ml-3 inline-block bg-linear-to-r from-cyan-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
              Hero AI Studio
              <span aria-hidden className="doc-shimmer absolute inset-0 pointer-events-none" />
            </span>
          </h1>
          <p className="doc-fade-up mt-2 text-base text-white/55 max-w-2xl leading-relaxed"
            style={{ animationDelay: "140ms" }}>
            สร้างวิดีโอ TikTok/Reels แนวตั้งจาก script เดียว — AI generate voice, ตัดซับ, หา B-roll, render เป็น MP4 ให้อัตโนมัติ
          </p>

          {/* Tab nav with glow pulse on active */}
          <div className="doc-fade-up mt-5 inline-flex items-stretch gap-1 rounded-2xl p-1.5 backdrop-blur-xl"
            style={{
              animationDelay: "220ms",
              background: "linear-gradient(135deg, hsl(0 0% 100% / 0.04), hsl(0 0% 100% / 0.02))",
              border: "1px solid hsl(0 0% 100% / 0.08)",
              boxShadow: "inset 0 1px 0 hsl(0 0% 100% / 0.05), 0 8px 32px hsl(0 0% 0% / 0.35)",
            }}>
            {tabs.map(t => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`group flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition-all duration-300 ${active ? "doc-tab-active" : ""}`}
                  style={active
                    ? {
                        background: "linear-gradient(135deg, hsl(190 100% 45% / 0.18), hsl(230 100% 55% / 0.15))",
                        color: "hsl(190 100% 78%)",
                        border: "1px solid hsl(190 100% 50% / 0.4)",
                      }
                    : { color: "rgba(255,255,255,0.45)", border: "1px solid transparent" }}>
                  <t.icon className={`h-3.5 w-3.5 transition-transform duration-300 ${active ? "" : "group-hover:scale-110 group-hover:rotate-3"}`} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Content area — z-10 so it sits above the fixed backdrop ───── */}
      <div className="relative z-10 mx-auto max-w-4xl px-4 pb-12 md:px-6">
        {/* Active tab indicator chip */}
        <div className="doc-fade-in mb-5 flex items-center gap-2 text-[11px] font-semibold text-white/40"
          style={{ animationDelay: "320ms" }}>
          <activeTab.icon className="h-3.5 w-3.5 text-cyan-400/70" />
          <span>กำลังอ่าน:</span>
          <span className="text-white/70">{activeTab.label}</span>
          <span className="doc-chip-dot ml-1 h-1.5 w-1.5 rounded-full bg-cyan-400" />
        </div>

        {/* Key on `tab` so content re-mounts and re-animates on tab change */}
        <div key={tab} className="doc-fade-up space-y-5" style={{ animationDelay: "380ms" }}>
          {tab === "api" && <ApiSetupDoc />}
          {tab === "video" && <VideoOnlyDoc />}
          {tab === "avatar" && <AvatarDoc />}
        </div>

        {/* Footer signature */}
        <div className="doc-fade-in mt-12 flex items-center justify-center gap-2 text-[10px] text-white/25 font-mono"
          style={{ animationDelay: "600ms" }}>
          <span className="h-px w-12 bg-linear-to-r from-transparent to-white/15" />
          <BookOpen className="h-3 w-3" />
          <span>Hero AI Studio Docs · studio.heroaiengine.com</span>
          <span className="h-px w-12 bg-linear-to-l from-transparent to-white/15" />
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   TAB 1 — ตั้งค่า API
═══════════════════════════════════════════════════ */
function ApiSetupDoc() {
  return (
    <>
      <Section title="ขั้นตอนแรก — ใส่ API Keys" icon={Key}>
        <p>
          ก่อนใช้งานต้องใส่ API Key ก่อนที่{" "}
          <a href="/settings" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">
            studio.heroaiengine.com/settings
          </a>
        </p>
        <div className="space-y-2.5 pt-1">
          <Step num={1} title="วาง key ในช่องที่กำหนด">
            <p>เข้าหน้า <b className="text-white">Settings</b> → วาง key แต่ละอันในช่องของมัน (กดไอคอน 👁 เพื่อดูค่าที่วาง)</p>
          </Step>
          <Step num={2} title="กด Test เพื่อยืนยัน">
            <p>กดปุ่ม <b className="text-white">Test</b> ข้างช่อง — ถ้าผ่านจะขึ้น <b className="text-green-400">✓ เครื่องหมายถูกสีเขียว</b>, ถ้าไม่ผ่านจะขึ้นข้อความ error สีแดงบอกสาเหตุ</p>
          </Step>
          <Step num={3} title="กด Save Settings">
            <p>กด <b className="text-white">Save Settings</b> มุมขวาล่าง — key ที่บันทึกแล้วจะมี badge <b className="text-green-400">Active</b> กำกับ</p>
          </Step>
        </div>
        <InfoBox>
          <span className="block space-y-2">
            <span className="block"><b className="text-white">ขั้นตอนที่ต้องทำก่อนใช้งาน Gemini Key:</b></span>
            <span className="block">① สร้าง key ที่ <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline text-cyan-300 hover:text-cyan-200">Google AI Studio → Create API Key</a></span>
            <span className="block">② <b className="text-white">เปิด Gemini API</b> ที่ <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer" className="underline text-cyan-300 hover:text-cyan-200">Google Cloud Console → Enable Generative Language API</a> — ถ้าข้ามขั้นนี้จะเจอ error 403</span>
            <span className="block">③ ถ้าใช้งานหลายคลิป แนะนำ <b className="text-white">ผูกบัตร Google</b> ใน project เดียวกัน เพื่อเพิ่มโควต้าและลดปัญหาโควต้าฟรีหมด</span>
            <span className="block text-white/50 text-[11px]">เข้า Console → เลือก project → ค้นหา "Generative Language API" → กด Enable → ผูกบัตร Google ถ้าต้องใช้งานต่อเนื่อง</span>
          </span>
        </InfoBox>
      </Section>

      <Section title="API Keys ที่ต้องใส่" icon={Settings2}>
        <div className="space-y-3">
          <p className="text-[12px] text-white/40 uppercase tracking-widest font-bold">LLM — สำหรับ subtitle split และ keyword</p>

          <ApiRow
            name="Gemini API Key"
            required
            desc="ใช้สำหรับ AI ทุกฟังก์ชัน — TTS, subtitle split, keyword extraction, style analysis, content generation  |  ต้องสร้าง key, เปิด Generative Language API และแนะนำให้ผูกบัตร Google ถ้าต้องใช้งานหลายคลิป"
            link="https://aistudio.google.com/app/apikey"
            linkLabel="① AI Studio → Create API Key"
          />
          <ApiRow
            name=""
            required={false}
            desc="หลังสร้าง key แล้ว ต้องเปิด API นี้ด้วย — เข้า Console → เลือก project → ค้นหา Generative Language API → Enable"
            link="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com"
            linkLabel="② Google Cloud Console → Enable Generative Language API"
          />

          <p className="text-[12px] text-white/40 uppercase tracking-widest font-bold pt-2">Stock Video — B-roll</p>
          <ApiRow
            name="Pexels API Key"
            required
            desc="ใช้ดึงคลิป B-roll จาก Pexels (ฟรี) ต้องมีอย่างน้อย 1 key ระหว่าง Pexels หรือ Pixabay"
            link="https://www.pexels.com/api/"
            linkLabel="Pexels API → Your API Key"
          />
          <ApiRow
            name="Pixabay API Key"
            required={false}
            desc="ออปชัน — ดึงคลิปจาก Pixabay เพิ่มเติม แนะนำให้ใส่ทั้งคู่เพื่อให้ได้คลิปหลากหลายขึ้น"
            link="https://pixabay.com/api/docs/"
            linkLabel="Pixabay API → Get API Key"
          />

          <p className="text-[12px] text-white/40 uppercase tracking-widest font-bold pt-2">TTS เสียง</p>
          <ApiRow
            name="ElevenLabs API Key"
            required={false}
            desc="ออปชัน — เสียงคุณภาพสูงมาก ใส่ API Key ที่นี่ ส่วน Voice ID กรอกใน Pipeline panel ตอนเลือก Voice = ElevenLabs ถ้าไม่มีให้ใช้ Gemini TTS แทนได้"
            link="https://elevenlabs.io/app/settings/api-keys"
            linkLabel="ElevenLabs → Profile → API Key"
          />

          <p className="text-[12px] text-white/40 uppercase tracking-widest font-bold pt-2">Avatar (ถ้าใช้โหมด Avatar)</p>
          <ApiRow
            name="HeyGen API Key"
            required={false}
            desc="จำเป็นเฉพาะโหมด Avatar → Generate ใช้สำหรับสร้างวิดีโอ avatar พูดพร้อมพื้นหลังสีเขียว ถ้าใช้ Direct URL ไม่ต้องใส่"
            link="https://app.heygen.com/settings?nav=API"
            linkLabel="HeyGen → Settings → API"
          />
        </div>
      </Section>

      <Section title="เช็ค key ว่าทำงานได้มั้ย" icon={CheckCircle2}>
        <p>มี 2 วิธี:</p>
        <ul className="space-y-1.5 list-disc list-inside ml-1">
          <li><b className="text-white">ที่หน้า Settings</b> — กดปุ่ม <b className="text-white">Test</b> ข้างแต่ละ key ดูว่าขึ้น ✓ เขียวมั้ย</li>
          <li><b className="text-white">ใช้งานจริง</b> — เข้า <b className="text-white">Video Editor</b> → วาง script สั้นๆ → กด <b className="text-white">▶ Render</b> ถ้า key ผิดจะขึ้น popup ให้กรอก key ใหม่ทันที</li>
        </ul>
        <InfoBox>ถ้าขึ้น popup ให้ใส่ key ระหว่างใช้งาน กรอกตรงนั้นได้เลย หรือไปแก้ที่ Settings แล้วรันใหม่</InfoBox>
      </Section>

      <Section title="เจอปัญหา? วิธีแก้" icon={AlertTriangle}>
        <div className="space-y-3">
          <ErrBox title="Gemini key ใช้ไม่ได้ / Test ขึ้นแดง / ขึ้น 401 invalid">
            <p>มักเกิดจาก copy key มาไม่ครบ หรือ key ถูก Google revoke (เช่นเผลอ paste ในแชต/ที่สาธารณะ)</p>
            <p>→ เข้า <b className="text-white">Google AI Studio</b> สร้าง key ใหม่ (กด <b className="text-white">+ Create API key</b>) → วางใหม่ → กด Test → <b className="text-white">ห้าม share key ที่ไหนอีก</b></p>
          </ErrBox>
          <ErrBox title='Test ขึ้น "Generative Language API ยังไม่ได้เปิด"'>
            <p>key ส่วนใหญ่ใช้ได้เลย แต่บาง project เก่าต้องเปิด API เอง</p>
            <p>→ เข้า{" "}
              <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">Google Cloud Console</a>{" "}
              → เลือก project เดียวกับที่สร้าง key → กด <b className="text-white">ENABLE</b> → รอ 1-2 นาที → Test ใหม่</p>
          </ErrBox>
          <ErrBox title="Test ผ่าน แต่ TTS / Render fail ขึ้น 503 high demand">
            <p>Google Gemini ฝั่ง server overload ชั่วคราว ไม่ใช่ที่ key — ระบบ retry อัตโนมัติให้แล้ว</p>
            <p>→ รอ 5-10 นาทีแล้วลองใหม่ หรือสลับ Voice เป็น <b className="text-white">ElevenLabs</b> ใน Pipeline panel</p>
          </ErrBox>
          <ErrBox title="ขึ้นว่า Gemini โควต้าฟรีเต็ม / quota เต็ม">
            <p>Gemini key ใช้โควต้าฟรีอยู่ และโควต้าของ Google หมดแล้ว โดยเฉพาะตอนสร้างเสียง ถอดซับ หรือหา keyword หลายครั้งติดกัน</p>
            <p>→ รอรอบรีเซ็ตของ Google หรือผูกบัตร Google ใน project เดียวกับ key เพื่อเพิ่มโควต้า</p>
          </ErrBox>
          <ErrBox title="B-roll หาคลิปไม่เจอ / ขึ้น error ที่ขั้น B-roll">
            <p>เช็คว่าใส่ <b className="text-white">Pexels</b> หรือ <b className="text-white">Pixabay</b> key อย่างน้อย 1 ตัว และกด Test ผ่าน</p>
            <p>→ แนะนำใส่ทั้งคู่ แล้วเลือก Stock Source = <b className="text-white">Both</b> เพื่อให้มีคลิปให้เลือกมากขึ้น</p>
          </ErrBox>
          <ErrBox title="โหมด Avatar (Generate) สร้าง avatar ไม่ได้">
            <p>ต้องใส่ <b className="text-white">HeyGen API Key</b> และ Test ผ่านก่อน (เฉพาะโหมด Generate)</p>
            <p>→ ถ้าไม่อยากใช้ HeyGen โควต้า ใช้โหมด <b className="text-white">Direct URL</b> แทน ไม่ต้องใส่ HeyGen key</p>
          </ErrBox>
          <ErrBox title="ใส่ key แล้วแต่ระบบยังบอกว่าไม่มี key">
            <p>ลืมกด <b className="text-white">Save Settings</b> — เช็คว่า key มี badge <b className="text-green-400">Active</b> แล้ว</p>
            <p>→ ถ้ายังไม่มี ให้กด Save อีกครั้ง แล้ว refresh หน้า</p>
          </ErrBox>
        </div>
        <InfoBox>Gemini TTS เป็น preview model — ถ้า Test ข้อความผ่านแต่เสียง fail ทุก model ให้ใช้ ElevenLabs สำหรับ voice ไปก่อน</InfoBox>
      </Section>
    </>
  );
}

/* ═══════════════════════════════════════════════════
   TAB 2 — Video Editor
═══════════════════════════════════════════════════ */
function VideoOnlyDoc() {
  return (
    <>
      <Section title="ทำความรู้จัก Video Editor" icon={Film}>
        <p>
          หน้า <b className="text-white">/video-editor</b> เป็นเครื่องมือสร้างวิดีโอ
          <b className="text-white"> TikTok/Reels 9:16 (1080×1920)</b> จาก script ภาษาไทย
          โดยระบบจะ generate voice → ตัดซับ → หา B-roll → render เป็น MP4 ให้อัตโนมัติ
          พร้อม <b className="text-white">timeline editor</b> ให้แก้ละเอียดทุก clip ทุก subtitle
        </p>
        <InfoBox>โครงสร้างหน้า: ซ้าย = Transcript / กลาง = Preview / ขวา = Pipeline + Settings / ล่าง = Timeline</InfoBox>
      </Section>

      <Section title="ขั้นตอนการสร้างวิดีโอ" icon={Wand2}>
        <Step num={1} title="กรอก Script (panel ซ้ายสุด)">
          <p>พิมพ์ script ในกล่อง <b className="text-white">Transcript</b> ทางซ้ายสุดของหน้า</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">บรรทัดเปล่าคั่น</b> = แบ่ง scene ระบบจะใช้เป็น natural break</li>
            <li><b className="text-white">บรรทัดแรก</b> = hook ดึงดูดคนใน 3 วินาทีแรก</li>
            <li><b className="text-white">บรรทัดสุดท้าย</b> = CTA เช่น "กดติดตาม", "ไลค์/แชร์"</li>
          </ul>
          <Warn>อย่าใส่ stage direction เช่น (หยุดพัก) หรือ [เสียงดนตรี] — จะปนเข้าซับ</Warn>
        </Step>

        <Step num={2} title="ตั้งค่า Pipeline (panel ขวา — แถบ Pipeline)">
          <p>เลือกค่าก่อนรัน:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">Stock Source</b> — Pexels / Pixabay / Both (แนะนำ Both)</li>
            <li><b className="text-white">Voice</b> — Gemini (ใช้ key ของคุณเอง) หรือ ElevenLabs (เสียงดีกว่า)</li>
            <li><b className="text-white">Background Music</b> — toggle on → เลือกเพลง system หรือ upload mp3</li>
            <li><b className="text-white">Avatar (HeyGen)</b> — toggle on ถ้าอยากให้ avatar พูด (ดู tab + Avatar)</li>
          </ul>
        </Step>

        <Step num={3} title="ตั้ง Subtitle Style (panel ขวาสุด — Settings)">
          <p>มี 2 แท็บ:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">สไตล์</b> — เลือก Caption Style (17 presets: มาตรฐาน, Hormozi, Beast, Karaoke, Neon ...) และ Text Animation (pop, bounce, fade, glow, highlight ...)</li>
            <li><b className="text-white">Font</b> — เลือก font (12 ตัว: Kanit, Mitr, K2D, Chonburi ...), Size 30-160px, B/Shadow/Outline, สี Text + Accent, Vertical Position 10-95%</li>
          </ul>
          <InfoBox>preset บางตัว (Hormozi, Beast, Neon, Pastel) ล็อกสีเพราะออกแบบมาแล้ว — เลือกสีไม่ได้</InfoBox>
        </Step>

        <Step num={4} title="กดปุ่ม Render (ขวาบน)">
          <p>เมื่อตั้งทุกอย่างแล้ว กด <b className="text-white">▶ Render</b> ที่ topbar — ระบบจะรัน pipeline 6 steps อัตโนมัติ</p>
          <Warn>อย่าปิด tab หรือเปลี่ยนหน้าระหว่างรัน — pipeline จะหยุดกลางทาง</Warn>
          <p>ดู progress แต่ละ step ได้ที่ <b className="text-white">Process</b> panel (ใต้ Transcript)</p>
        </Step>
      </Section>

      <Section title="Pipeline 6 ขั้น (รันอัตโนมัติเมื่อกด Render)" icon={Layers}>
        <div className="rounded-xl p-4 mt-2" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
          <PipelineRow num={1} name="TTS Voice" desc="ส่ง script ให้ Gemini หรือ ElevenLabs สังเคราะห์เสียง → ไฟล์ WAV (เก็บที่ /public/renders/tts-xxx.wav)" />
          <PipelineRow num={2} name="Transcribe" desc="ส่ง audio + script ให้ Gemini แล้ว LLM ตัดเป็นซับพร้อม timestamp (มี model fallback chain 3.5 → 2.5 → 1.5 กัน Google ฝั่ง overload)" />
          <PipelineRow num={3} name="Keywords" desc="LLM อ่าน caption แต่ละช่วง → แปลงเป็น keyword ภาษาอังกฤษสำหรับค้น B-roll (1 caption = 1 keyword)" />
          <PipelineRow num={4} name="B-roll" desc="ค้น Pexels/Pixabay ด้วย keyword → LLM rank คลิปที่ตรง → ดาวน์โหลด MP4 cache ที่ /stocks/" />
          <PipelineRow num={5} name="Config" desc="จับคู่คลิป B-roll กับ timestamp ของซับ → สร้าง timeline JSON ให้ Remotion" />
          <PipelineRow num={6} name="Render" desc="Remotion render: คลิปเล่นตรงช่วงเวลาของซับ + ซับ popup ตรงจังหวะ → MP4 9:16 สุดท้าย (เก็บที่ /public/renders/render-xxx.mp4)" />
        </div>
        <InfoBox>ถ้า step ไหน fail สามารถกดปุ่ม <b className="text-white">▶ Run</b> ข้างชื่อ step นั้น เพื่อ re-run อันเดียว ไม่ต้องเริ่มใหม่หมด</InfoBox>
      </Section>

      <Section title="Timeline (panel ล่างสุด)" icon={Captions}>
        <p>หลัง render เสร็จ Timeline จะแสดง 4 tracks:</p>
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>💬 <b className="text-white">Subtitles</b> — clip สีส้ม (body) / เหลือง (hook) / แดง (cta)</li>
          <li>🎬 <b className="text-white">B-roll</b> — clip สีฟ้า รายการ stock videos</li>
          <li>🎤 <b className="text-white">Voice</b> — track เขียว แสดง TTS audio</li>
          <li>🎵 <b className="text-white">Music</b> — track ม่วง ถ้าเปิด BGM</li>
        </ul>

        <p className="pt-2 font-bold text-white">การแก้ Subtitle ใน Timeline:</p>
        <ul className="list-disc list-inside space-y-0.5 ml-1">
          <li><b className="text-white">คลิก clip</b> → select + seek ไปจุดเริ่ม</li>
          <li><b className="text-white">ลากกลาง clip</b> → ย้ายตำแหน่ง (ความยาวคงเดิม)</li>
          <li><b className="text-white">ลากขอบซ้าย/ขวา</b> → resize start/end</li>
          <li><b className="text-white">ดับเบิ้ลคลิก</b> → แก้ข้อความ</li>
          <li><b className="text-white">✂️ Split</b> (toolbar) → ตัด clip ที่ตำแหน่ง playhead</li>
          <li><b className="text-white">🗑️ Delete</b> (toolbar) → ลบ clip ที่ select</li>
          <li><b className="text-white">🔍 Zoom slider</b> → ย่อ/ขยาย timeline 0-100% (0% = ภาพรวม, 100% = ละเอียดสุด)</li>
        </ul>

        <InfoBox>เมื่อแก้ซับ → กด <b className="text-white">▶ Render</b> ใหม่ → ระบบจะ re-render เฉพาะ step Render (ประหยัด TTS/B-roll ที่ทำไว้แล้ว)</InfoBox>
      </Section>

      <Section title="Drafts (บันทึกงาน)" icon={RefreshCw}>
        <p>ระบบ auto-save งานเป็น <b className="text-white">draft</b> ใน browser ของคุณตลอดเวลา</p>
        <ul className="list-disc list-inside space-y-0.5 ml-1">
          <li>กดปุ่ม <b className="text-white">Draft (N)</b> บน topbar → เห็นรายการ project ทั้งหมด</li>
          <li>กด <b className="text-white">+ New</b> → เริ่ม project ใหม่ (reset ทุก setting รวม script, style, captions, BGM, avatar)</li>
          <li>คลิกชื่อ draft → load งานเก่ามาแก้ต่อ</li>
          <li>ปุ่ม <b className="text-white">🗑️</b> ข้างชื่อ draft → ลบ draft นั้น</li>
        </ul>
        <Warn>Draft เก็บใน localStorage ของ browser นี้เท่านั้น — ใช้ browser อื่นจะมองไม่เห็น</Warn>
      </Section>

      <Section title="Playback Controls (Preview กลาง)" icon={Play}>
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li><b className="text-white">▶ Play / ⏸ Pause</b> — เล่น/หยุด preview</li>
          <li><b className="text-white">⏮ ⏭ Skip</b> — ย้อน/เดินหน้า 5 วินาที</li>
          <li><b className="text-white">Scrubber bar</b> — hover เห็นเวลา (preview tooltip), คลิก = seek, ลาก = drag</li>
          <li><b className="text-white">🔊 Volume</b> — hover ที่ icon ลำโพง → vertical slider โผล่ขึ้น ลากปรับเสียง preview</li>
          <li><b className="text-white">⛶ Fullscreen</b> — ขยาย editor เต็มจอ</li>
        </ul>
      </Section>

      <Section title="แก้ปัญหาที่พบบ่อย" icon={RefreshCw}>
        <div className="space-y-3">
          <ErrBox title="TTS / Transcribe fail ขึ้น 503 high demand">
            <p>Google Gemini ฝั่ง server overload ชั่วคราว — ระบบ retry อัตโนมัติ 3 ครั้ง × 3 models</p>
            <p>ถ้ายัง fail หมด → รอ 5-10 นาที หรือสลับ Voice → ElevenLabs</p>
          </ErrBox>
          <ErrBox title="Toast บอก Generative Language API ยังไม่ได้เปิด">
            <p>กด <b className="text-white">action button</b> ใน toast → เปิด Google Cloud Console</p>
            <p>กด <b className="text-white">ENABLE</b> → รอ 1-2 นาที → Test ใน Settings ใหม่</p>
          </ErrBox>
          <ErrBox title="Toast บอก Gemini key ไม่ถูกต้อง / 401">
            <p>Key ถูก Google revoke (มักจาก paste ใน chat/public)</p>
            <p>กด action button → ไป aistudio → สร้าง key ใหม่ → <b className="text-white">ห้าม share ที่ไหนอีก</b></p>
          </ErrBox>
          <ErrBox title="ปุ่ม Render กดไม่ติด / หน้าค้าง">
            <p>เช็คว่า script ไม่ว่าง (อย่างน้อย 1 บรรทัด)</p>
            <p>เช็คว่าตั้ง Gemini key แล้วใน Settings → API Keys</p>
            <p>กด F12 เปิด DevTools → ดู Console error</p>
          </ErrBox>
          <ErrBox title="ซับแบ่งไม่สวย / ตัดกลางคำ">
            <p>กดปุ่ม <b className="text-white">▶ Run</b> ข้าง Transcribe เพื่อให้ LLM แบ่งใหม่ (มี randomness ในแต่ละครั้ง)</p>
            <p>หรือแก้ตรงใน Timeline ด้วย Split / Delete / Drag</p>
          </ErrBox>
        </div>
      </Section>

      <Section title="เคล็ดลับ" icon={Play}>
        <ul className="space-y-2">
          <Tip>ใช้ <b className="text-white">+ New</b> เริ่ม project ใหม่ทุกครั้ง — กัน state ของ project เก่าหลุดมา</Tip>
          <Tip>เปลี่ยน font/สี/style → ไม่ต้อง re-render — preview สดทันที (Render เมื่อจะ export MP4)</Tip>
          <Tip>ลาก clip ใน timeline ได้สะดวก — ลากกลาง = ย้าย, ลากขอบ = resize</Tip>
          <Tip>Script 1-3 นาทีรองรับได้ดี — เกิน 5 นาที pipeline จะช้าขึ้นที่ขั้น B-roll</Tip>
          <Tip>ถ้า Gemini TTS รวน → สลับเป็น ElevenLabs ใน Pipeline panel (ต้องใส่ ElevenLabs key + Voice ID)</Tip>
        </ul>
      </Section>
    </>
  );
}

/* ═══════════════════════════════════════════════════
   TAB 3 — Avatar
═══════════════════════════════════════════════════ */
function AvatarDoc() {
  return (
    <>
      <Section title="โหมด Avatar + วิดีโอ" icon={User}>
        <p>
          สร้างวิดีโอเหมือนโหมดวิดีโออย่างเดียว แต่เพิ่ม <b className="text-white">avatar คนพูด</b> ซ้อนทับบน B-roll
          โดยลบพื้นหลังสีเขียวออกอัตโนมัติด้วย FFmpeg chromakey
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mt-2">
          <div className="rounded-xl p-4" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
            <p className="text-white font-bold text-[13px] mb-1">Generate (HeyGen API)</p>
            <p className="text-[12px] text-white/50">ระบบสร้าง avatar พูดให้ผ่าน HeyGen ต้องใส่ HeyGen API Key + Avatar ID — <span className="text-amber-300/80">กิน HeyGen โควต้าทุกครั้งที่ generate</span></p>
          </div>
          <div className="rounded-xl p-4" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
            <p className="text-white font-bold text-[13px] mb-1">Direct URL / ไฟล์</p>
            <p className="text-[12px] text-white/50">ใช้วิดีโอ avatar ที่มีอยู่แล้ว (พื้นเขียว) วาง URL หรืออัปโหลดไฟล์ MP4/MOV/WebM ได้เลย — <span className="text-emerald-300/80">ไม่เสีย HeyGen โควต้า</span></p>
          </div>
        </div>
      </Section>

      <Section title="ขั้นตอนก่อนกด Render" icon={Wand2}>
        <Step num={1} title="ตั้งค่าพื้นฐาน (เหมือนโหมดวิดีโออย่างเดียว)">
          <p>วาง Script (panel ซ้าย) → เลือก Stock Source → เลือก Voice → ตั้ง Subtitle Style</p>
          <p>(ดูรายละเอียดใน tab <b className="text-white">Video Editor</b>)</p>
        </Step>

        <Step num={2} title="เปิดโหมด Avatar (panel Pipeline ขวา)">
          <p>เปิด toggle <b className="text-white">Avatar (HeyGen)</b> → เลือกโหมด <b className="text-white">Generate</b> หรือ <b className="text-white">Direct URL</b></p>
          <InfoBox>โหมด <b className="text-white">Direct URL</b> ไม่กิน HeyGen โควต้า — ถ้ามีวิดีโอ avatar พื้นเขียวอยู่แล้วแนะนำใช้อันนี้</InfoBox>
        </Step>

        <Step num={3} title="(โหมด Generate) ใส่ Avatar ID + เลือก Timing">
          <p>ใส่ <b className="text-white">HeyGen Avatar ID</b> — หา ID ได้จาก HeyGen dashboard ที่ตัว avatar ที่ต้องการ</p>
          <p className="pt-1">เลือก <b className="text-white">Avatar Timing</b> (ช่วงเวลาที่ avatar ปรากฏ):</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li><b className="text-white">Full</b> — avatar แสดงตลอดคลิป</li>
            <li><b className="text-white">Intro</b> — แสดงเฉพาะ N วินาทีแรก (กำหนดวินาทีได้) หลังจากนั้นเหลือแต่ B-roll</li>
            <li><b className="text-white">Intro+Outro</b> — แสดงช่วงต้นคลิป N วินาที + ช่วงท้ายคลิป N วินาที</li>
          </ul>
          <Warn>
            HeyGen คิดเงินตามโควต้าทุกครั้งที่ generate avatar ใหม่ — ตั้ง Avatar ID + Timing ให้เรียบร้อยก่อนกด Render
          </Warn>
        </Step>

        <Step num={4} title="(โหมด Generate) วางตำแหน่ง avatar — Avatar Position">
          <p>ลากจุดบน canvas หรือปรับ slider <b className="text-white">Offset X / Offset Y / Scale</b> เพื่อจัดตำแหน่ง avatar บน B-roll</p>
          <p>กด <b className="text-white">↺ Reset</b> เพื่อกลับค่า default (เห็น upper body)</p>
          <InfoBox>ตำแหน่งนี้ปรับใหม่ทีหลังได้โดย <b className="text-white">ไม่ต้อง generate avatar ใหม่</b> — ประหยัด HeyGen โควต้า (ดูหัวข้อถัดไป)</InfoBox>
        </Step>

        <Step num={5} title="(โหมด Direct URL) วาง URL หรืออัปโหลดไฟล์">
          <p>วาง URL วิดีโอ avatar พื้นเขียว หรืออัปโหลดไฟล์ MP4/MOV/WebM — เสียงจะใช้จากวิดีโอนั้นเลย (ข้าม TTS)</p>
        </Step>

        <Step num={6} title="กด ▶ Render (topbar ขวาบน)">
          <p>ปุ่มเดียวกับโหมดวิดีโอ — ระบบรัน pipeline ทั้งหมดต่อเนื่อง แล้ว <b className="text-white">composite avatar ให้อัตโนมัติ</b> ตอนท้าย</p>
          <Warn>ห้ามปิด tab หรือเปลี่ยนหน้าระหว่าง pipeline รัน</Warn>
        </Step>
      </Section>

      <Section title="ขั้นตอน Pipeline (รันอัตโนมัติเมื่อกด Render)" icon={Layers}>
        <p className="text-[12px] text-white/40">โหมด Avatar รันเหมือนโหมดวิดีโอ แล้วต่อด้วยขั้น Avatar + Composite ตอนท้าย:</p>
        <div className="rounded-xl p-4 mt-2" style={{ background: "var(--ui-btn-bg)", border: "1px solid var(--ui-card-border)" }}>
          <PipelineRow num={1} name="TTS Voice" desc="ส่ง script ให้ Gemini หรือ ElevenLabs สังเคราะห์เสียงพูด (โหมด Direct URL ข้ามขั้นนี้ — ใช้เสียงจากวิดีโอ avatar)" />
          <PipelineRow num={2} name="Transcribe" desc="ส่ง audio + script ให้ Gemini → LLM แบ่งเป็นซับพร้อม timestamp ตรงกับเสียง" />
          <PipelineRow num={3} name="Keywords" desc="LLM อ่านซับแต่ละประโยค → แปลงเป็น keyword ภาษาอังกฤษสำหรับค้น B-roll (1 ซับ = 1 keyword)" />
          <PipelineRow num={4} name="B-roll" desc="ค้น Pexels/Pixabay ด้วย keyword → LLM rank คลิปที่ตรงที่สุด → ดาวน์โหลด MP4 cache ที่ /stocks/" />
          <PipelineRow num={5} name="Config" desc="จับคู่คลิป B-roll กับ timestamp ของซับแต่ละประโยค → สร้าง timeline ให้ Remotion" />
          <PipelineRow num={6} name="Render" desc="Remotion render: คลิปเล่นตรงช่วงเวลาของซับ + ซับ popup ตรงจังหวะเสียง → วิดีโอ background" />
          <PipelineRow num={7} name="Avatar (HeyGen)" desc="HeyGen สร้างวิดีโอ avatar พูดบนพื้นหลังสีเขียว (เฉพาะโหมด Generate — กิน HeyGen โควต้า)" />
          <PipelineRow num={8} name="Composite (FFmpeg)" desc="ลบพื้นเขียว (chromakey) → overlay avatar บน background ตามตำแหน่งที่ตั้ง → MP4 สุดท้าย" />
        </div>
        <InfoBox>คลิป B-roll และซับ sync กันเสมอ — ซับที่ 1 ได้ keyword จากประโยคที่ 1 → คลิปที่ 1 ตรงกับซับที่ 1</InfoBox>
      </Section>

      <Section title="ปรับ Background Removal (Chromakey)" icon={Captions}>
        <p>
          ในการ์ด Avatar จะมีกล่อง <b className="text-white">Background Removal</b> สำหรับปรับการลบพื้นเขียว
          ตั้งค่าได้ก่อนกด Render และปรับซ้ำได้ตลอด มี 2 ค่า:
        </p>
        <ul className="list-disc list-inside space-y-0.5 ml-1">
          <li><b className="text-white">Similarity</b> (0.10–0.55) — เขียวยังเหลือ → เพิ่มค่า / ผิวหรือเสื้อหาย → ลดค่า</li>
          <li><b className="text-white">Blend</b> (0.00–0.20) — ขอบหยัก → เพิ่มค่า / ต้องการขอบนิ่มน้อยลง → ลดค่า</li>
        </ul>
        <InfoBox>สีพื้นที่ลบคือเขียว <b className="text-white">#00FF00</b> — วิดีโอ avatar ควรเป็นพื้นเขียวสะอาด ไม่มีเงาบนหน้า เพื่อให้ chromakey ลบได้คม</InfoBox>
      </Section>

      <Section title="แก้ avatar โดยไม่เสีย HeyGen โควต้า" icon={RefreshCw}>
        <p>หลัง Render เสร็จ ถ้า avatar ตำแหน่งไม่ลงตัวหรือยังมีขอบเขียว ปรับแล้ว Render ใหม่ได้:</p>
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li>ปรับ <b className="text-white">Offset X/Y / Scale</b> (Avatar Position) หรือค่า <b className="text-white">Background Removal</b></li>
          <li>กด <b className="text-white">▶ Render</b> ใหม่ — ระบบ composite ใหม่จากวิดีโอ avatar เดิม</li>
        </ul>
        <Warn>
          ตราบใดที่ <b className="text-white">Avatar ID ยังเป็นตัวเดิม</b> ระบบจะใช้วิดีโอ avatar ที่ generate ไว้แล้ว
          ไม่ generate ใหม่ จึงไม่เสีย HeyGen โควต้าเพิ่ม — เปลี่ยน Avatar ID เมื่อใดจึงจะ generate (และเสียโควต้า) ใหม่
        </Warn>
        <p className="pt-1">วิดีโอสุดท้ายบันทึกลง Gallery อัตโนมัติ</p>
      </Section>

      <Section title="เคล็ดลับ" icon={Play}>
        <ul className="space-y-2">
          <Tip>ถ้ามี avatar video พื้นเขียวอยู่แล้ว → ใช้ <b className="text-white">Direct URL</b> เร็วกว่า และ <b className="text-white">ไม่เสีย HeyGen โควต้า</b></Tip>
          <Tip>ตั้ง Avatar Timing = <b className="text-white">Intro 5–10 วินาที</b> มักดูธรรมชาติกว่า avatar พูดตลอดคลิป</Tip>
          <Tip>ถ้า avatar ตำแหน่งไม่ลงตัว → ปรับ slider แล้วกด <b className="text-white">▶ Render</b> ใหม่ (Avatar ID เดิม = ไม่เสียโควต้า)</Tip>
          <Tip>วิดีโอ avatar ต้องมีพื้นหลังสีเขียวสะอาด ไม่มีเงาบนใบหน้า เพื่อให้ chromakey ลบได้คม</Tip>
          <Tip>ปรับ Similarity/Blend จน avatar ขอบสะอาดแล้วค่อย Render เป็นไฟล์สุดท้าย</Tip>
        </ul>
      </Section>
    </>
  );
}
