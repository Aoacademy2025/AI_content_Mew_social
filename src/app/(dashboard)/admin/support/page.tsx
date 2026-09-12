"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Ticket, CheckCircle2, Clock, Send, ChevronDown, ChevronUp,
  Loader2, X, Bug, Lightbulb, SearchCheck, Maximize2, ClipboardCheck, Save, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

// Violet single-accent house tokens (from video-editor/_v2/tokens.ts) — see dashboard/page.tsx
const VIOLET = "#8B5CF6";
const VIOLET_GRAD = "linear-gradient(180deg,#8B66F8,#6C4CF4)";
const VIOLET_LIGHT = "#B9A6FF";
const VIOLET_TILE_BG = "rgba(139,92,246,.10)";
const VIOLET_TILE_BORDER = "hsl(258 90% 66% / .45)";
// Flat v2 card surface — inline var(--ui-*), matches settings/dashboard (no .ve-card helper)
const cardStyle: React.CSSProperties = { background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" };

interface SupportTicket {
  id: string;
  message: string;
  imageName: string | null;
  imageBase64?: string | null;
  imageMimeType: string | null;
  status: "OPEN" | "CLOSED";
  adminReply: string | null;
  category: SupportTicketCategory | null;
  severity: SupportTicketSeverity | null;
  recommendedAction: SupportRecommendation | null;
  auditNote: string | null;
  impactNote: string | null;
  sentryIssueId: string | null;
  sentryIssueUrl: string | null;
  linearIssueIdentifier: string | null;
  linearIssueUrl: string | null;
  auditedAt: string | null;
  createdAt: string;
  user: { name: string; email: string; plan: string };
}

type SupportTicketCategory = "BUG_CONFIRMED" | "FEATURE_REQUEST" | "USER_CONFUSION" | "NEED_MORE_INFO" | "NOT_A_BUG";
type SupportTicketSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type SupportRecommendation = "FIX" | "ADD_FEATURE" | "NEED_MORE_INFO" | "WONT_FIX" | "MONITOR";

type TriageDraft = {
  category: SupportTicketCategory | "";
  severity: SupportTicketSeverity | "";
  recommendedAction: SupportRecommendation | "";
  auditNote: string;
  impactNote: string;
  sentryIssueReference: string;
  linearIssueReference: string;
};

const CATEGORY_OPTIONS: Array<{ value: SupportTicketCategory; label: string; icon: ReactNode }> = [
  { value: "BUG_CONFIRMED", label: "Bug จริง", icon: <Bug className="h-3 w-3" /> },
  { value: "FEATURE_REQUEST", label: "Feature request", icon: <Lightbulb className="h-3 w-3" /> },
  { value: "USER_CONFUSION", label: "User เข้าใจผิด", icon: <SearchCheck className="h-3 w-3" /> },
  { value: "NEED_MORE_INFO", label: "ต้องถามเพิ่ม", icon: <Clock className="h-3 w-3" /> },
  { value: "NOT_A_BUG", label: "ไม่ใช่บัค", icon: <CheckCircle2 className="h-3 w-3" /> },
];

const SEVERITY_OPTIONS: Array<{ value: SupportTicketSeverity; label: string; className: string }> = [
  { value: "LOW", label: "Low", className: "text-zinc-400 border-zinc-500/25 bg-zinc-500/10" },
  { value: "MEDIUM", label: "Medium", className: "text-sky-300 border-sky-500/25 bg-sky-500/10" },
  { value: "HIGH", label: "High", className: "text-orange-300 border-orange-500/25 bg-orange-500/10" },
  { value: "CRITICAL", label: "Critical", className: "text-red-300 border-red-500/30 bg-red-500/10" },
];

const RECOMMENDATION_OPTIONS: Array<{ value: SupportRecommendation; label: string }> = [
  { value: "FIX", label: "เสนอแก้บัค" },
  { value: "ADD_FEATURE", label: "เสนอเพิ่มฟีเจอร์" },
  { value: "NEED_MORE_INFO", label: "ขอข้อมูลเพิ่ม" },
  { value: "WONT_FIX", label: "ไม่ควรทำ" },
  { value: "MONITOR", label: "เฝ้าดูต่อ" },
];

function categoryLabel(value: SupportTicketCategory | null) {
  return CATEGORY_OPTIONS.find(o => o.value === value)?.label ?? null;
}

function severityMeta(value: SupportTicketSeverity | null) {
  return SEVERITY_OPTIONS.find(o => o.value === value) ?? null;
}

function recommendationLabel(value: SupportRecommendation | null) {
  return RECOMMENDATION_OPTIONS.find(o => o.value === value)?.label ?? null;
}

export default function AdminSupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [ticketFilter, setTicketFilter] = useState<"OPEN" | "CLOSED" | "ALL">("OPEN");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<string | null>(null);
  const [triageDrafts, setTriageDrafts] = useState<Record<string, TriageDraft>>({});
  const [savingTriage, setSavingTriage] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{ src: string; name: string | null } | null>(null);

  // Fetch tickets — `silent` skips the loading spinner so background polling
  // doesn't make the list flicker. Latest data always wins (DB is the source
  // of truth), so tickets created via the web/n8n flow appear automatically.
  const fetchTickets = useCallback(async (silent = false) => {
    if (!silent) setTicketsLoading(true);
    try {
      const r = await fetch(`/api/admin/support?status=${ticketFilter}`, { cache: "no-store" });
      const d = await r.json();
      if (Array.isArray(d)) setTickets(d);
    } catch { /* keep current list on transient errors */ }
    finally { if (!silent) setTicketsLoading(false); }
  }, [ticketFilter]);

  // Initial load + re-load when the filter changes
  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  // Real-time-ish: poll every 15s while the tab is visible (pauses in background).
  // Timer + listener are torn down on unmount so navigating away from this page
  // stops the poll.
  useEffect(() => {
    const POLL_MS = 15_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => fetchTickets(true), POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.visibilityState === "visible") { fetchTickets(true); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [fetchTickets]);

  function draftFromTicket(ticket: SupportTicket): TriageDraft {
    return {
      category: ticket.category ?? "",
      severity: ticket.severity ?? "",
      recommendedAction: ticket.recommendedAction ?? "",
      auditNote: ticket.auditNote ?? "",
      impactNote: ticket.impactNote ?? "",
      sentryIssueReference: ticket.sentryIssueId ?? "",
      linearIssueReference: ticket.linearIssueIdentifier ?? "",
    };
  }

  function triageDraft(ticket: SupportTicket) {
    return triageDrafts[ticket.id] ?? draftFromTicket(ticket);
  }

  function updateTriageDraft(ticket: SupportTicket, patch: Partial<TriageDraft>) {
    setTriageDrafts(prev => ({
      ...prev,
      [ticket.id]: { ...draftFromTicket(ticket), ...prev[ticket.id], ...patch },
    }));
  }

  async function saveTriage(ticket: SupportTicket) {
    const draft = triageDraft(ticket);
    setSavingTriage(ticket.id);
    try {
      const res = await fetch("/api/admin/support", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketId: ticket.id,
          category: draft.category || null,
          severity: draft.severity || null,
          recommendedAction: draft.recommendedAction || null,
          auditNote: draft.auditNote,
          impactNote: draft.impactNote,
          sentryIssueId: draft.sentryIssueReference,
          linearIssueIdentifier: draft.linearIssueReference,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "บันทึก audit ไม่สำเร็จ");
        return;
      }
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, ...data.ticket } : t));
      setTriageDrafts(prev => {
        const next = { ...prev };
        delete next[ticket.id];
        return next;
      });
      toast.success("บันทึก audit แล้ว");
    } catch {
      toast.error("บันทึก audit ไม่สำเร็จ");
    } finally {
      setSavingTriage(null);
    }
  }

  async function handleReply(ticketId: string, close: boolean) {
    const reply = replyText[ticketId]?.trim();
    if (!reply && !close) return;
    setReplying(ticketId);
    try {
      const res = await fetch("/api/admin/support", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, reply: reply || undefined, status: close ? "CLOSED" : undefined }),
      });
      if (res.ok) {
        setTickets(prev => prev.map(t => t.id === ticketId
          ? { ...t, adminReply: reply || t.adminReply, status: close ? "CLOSED" : t.status }
          : t
        ));
        setReplyText(prev => ({ ...prev, [ticketId]: "" }));
        if (ticketFilter === "OPEN" && close) {
          setTickets(prev => prev.filter(t => t.id !== ticketId));
        }
      }
    } finally {
      setReplying(null);
    }
  }

  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      {imagePreview && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4" onClick={() => setImagePreview(null)}>
          <div className="relative max-h-[92vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-zinc-950" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <span className="truncate text-xs text-zinc-400">{imagePreview.name ?? "attachment"}</span>
              <button
                onClick={() => setImagePreview(null)}
                className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="ปิดรูป"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imagePreview.src} alt={imagePreview.name ?? "attachment"} className="max-h-[84vh] w-full object-contain bg-black" />
          </div>
        </div>
      )}
      <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 pt-4 md:pt-6 pb-12 space-y-8">
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2" style={{ color: "var(--ui-text-primary)" }}>
              <Ticket className="h-5 w-5" style={{ color: VIOLET }} />
              Support Tickets
              {tickets.length > 0 && ticketFilter === "OPEN" && (
                <span className="rounded-full text-xs px-2 py-0.5 font-bold" style={{ background: VIOLET_TILE_BG, color: VIOLET_LIGHT }}>{tickets.length}</span>
              )}
            </h2>
            {/* Filter tabs */}
            <div className="flex gap-1 rounded-lg p-1" style={cardStyle}>
              {(["OPEN", "CLOSED", "ALL"] as const).map(f => (
                <button key={f} onClick={() => setTicketFilter(f)}
                  className="px-3 py-1 rounded text-xs font-semibold transition-all"
                  style={ticketFilter === f
                    ? { background: VIOLET_GRAD, color: "#fff" }
                    : { color: "var(--ui-text-muted)" }}>
                  {f === "OPEN" ? "เปิด" : f === "CLOSED" ? "ปิดแล้ว" : "ทั้งหมด"}
                </button>
              ))}
            </div>
          </div>

          {ticketsLoading ? null : tickets.length === 0 ? (
            <div className="rounded-2xl flex flex-col items-center justify-center py-12 gap-2" style={cardStyle}>
              <CheckCircle2 className="h-8 w-8 text-green-400/40" />
              <p className="text-sm" style={{ color: "var(--ui-text-muted)" }}>ไม่มี ticket ที่{ticketFilter === "OPEN" ? "รอดำเนินการ" : "ปิดแล้ว"}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tickets.map(ticket => {
                const expanded = expandedId === ticket.id;
                const imageSrc = ticket.imageBase64
                  ? `data:${ticket.imageMimeType ?? "image/jpeg"};base64,${ticket.imageBase64}`
                  : ticket.imageName
                    ? `/api/admin/support/${encodeURIComponent(ticket.id)}/image`
                    : null;
                const draft = triageDraft(ticket);
                const catLabel = categoryLabel(ticket.category);
                const severity = severityMeta(ticket.severity);
                const recoLabel = recommendationLabel(ticket.recommendedAction);
                return (
                  <div key={ticket.id} className="rounded-2xl overflow-hidden" style={cardStyle}>
                    {/* Ticket header */}
                    <button className="w-full flex items-start gap-4 p-4 text-left hover:bg-white/5 transition-colors"
                      onClick={() => setExpandedId(expanded ? null : ticket.id)}>
                      <div className={`mt-0.5 shrink-0 h-2 w-2 rounded-full ${ticket.status === "OPEN" ? "bg-red-400" : "bg-green-400"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate" style={{ color: "var(--ui-text-primary)" }}>{ticket.user.name}</span>
                          <span className="text-xs" style={{ color: "var(--ui-text-muted)" }}>{ticket.user.email}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--ui-badge-neutral-bg)", color: "var(--ui-text-secondary)" }}>{ticket.user.plan}</span>
                          <span className="text-[10px] ml-auto" style={{ color: "var(--ui-text-muted)" }}>
                            {new Date(ticket.createdAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p className="text-sm mt-1 line-clamp-2" style={{ color: "var(--ui-text-secondary)" }}>{ticket.message}</p>
                        {ticket.adminReply && (
                          <p className="text-xs mt-1 flex items-center gap-1" style={{ color: "#34D399" }}>
                            <CheckCircle2 className="h-3 w-3" /> ตอบแล้ว
                          </p>
                        )}
                        {(catLabel || severity || recoLabel) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {catLabel && (
                              <span className="inline-flex items-center gap-1 rounded border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-200">
                                <ClipboardCheck className="h-3 w-3" /> {catLabel}
                              </span>
                            )}
                            {severity && (
                              <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${severity.className}`}>
                                {severity.label}
                              </span>
                            )}
                            {recoLabel && (
                              <span className="inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--ui-badge-neutral-bg)", borderColor: "var(--ui-badge-neutral-border)", color: "var(--ui-text-secondary)" }}>
                                {recoLabel}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {expanded ? <ChevronUp className="h-4 w-4 text-zinc-500 shrink-0" /> : <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" />}
                    </button>

                    {/* Expanded detail */}
                    {expanded && (
                      <div className="px-4 pb-4 space-y-3 pt-4" style={{ borderTop: "1px solid var(--ui-divider)" }}>
                        {/* Message */}
                        <div className="rounded-xl p-3" style={{ background: "var(--ui-card-bg-2)" }}>
                          <p className="text-xs mb-1 font-semibold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>ปัญหา</p>
                          <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--ui-text-secondary)" }}>{ticket.message}</p>
                        </div>

                        {/* Image attachment */}
                        {imageSrc && (
                          <div className="overflow-hidden rounded-xl" style={{ border: "1px solid var(--ui-divider)" }}>
                            <button
                              type="button"
                              onClick={() => setImagePreview({ src: imageSrc, name: ticket.imageName })}
                              className="group relative block w-full bg-black/30"
                            >
                              <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg border border-white/10 bg-black/60 px-2 py-1 text-[10px] font-medium text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100">
                                <Maximize2 className="h-3 w-3" /> ดูเต็ม
                              </span>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={imageSrc}
                              alt={ticket.imageName ?? "attachment"}
                              className="w-full max-h-64 object-contain bg-black/30"
                            />
                            </button>
                            {ticket.imageName && <p className="px-3 py-1 text-[10px] text-zinc-500">{ticket.imageName}</p>}
                          </div>
                        )}

                        {/* Audit */}
                        <div className="rounded-xl p-3" style={{ background: "rgba(139,92,246,.06)", border: "1px solid rgba(167,139,250,.25)" }}>
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <ClipboardCheck className="h-4 w-4" style={{ color: VIOLET_LIGHT }} />
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: VIOLET_LIGHT }}>Ticket Audit</p>
                                <p className="text-[10px]" style={{ color: "var(--ui-text-muted)" }}>
                                  {ticket.auditedAt
                                    ? `อัปเดต ${new Date(ticket.auditedAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                                    : "ยังไม่ได้ audit"}
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => saveTriage(ticket)}
                              disabled={savingTriage === ticket.id}
                              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-45"
                              style={{ background: VIOLET_TILE_BG, border: `1px solid ${VIOLET_TILE_BORDER}`, color: VIOLET_LIGHT }}
                            >
                              {savingTriage === ticket.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                              บันทึก audit
                            </button>
                          </div>

                          <div className="grid gap-2 md:grid-cols-3">
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ประเภท</span>
                              <select
                                value={draft.category}
                                onChange={e => updateTriageDraft(ticket, { category: e.target.value as SupportTicketCategory | "" })}
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                              >
                                <option value="">ยังไม่จัดประเภท</option>
                                {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ความรุนแรง</span>
                              <select
                                value={draft.severity}
                                onChange={e => updateTriageDraft(ticket, { severity: e.target.value as SupportTicketSeverity | "" })}
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                              >
                                <option value="">ยังไม่ประเมิน</option>
                                {SEVERITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ข้อเสนอ</span>
                              <select
                                value={draft.recommendedAction}
                                onChange={e => updateTriageDraft(ticket, { recommendedAction: e.target.value as SupportRecommendation | "" })}
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                              >
                                <option value="">ยังไม่เสนอ</option>
                                {RECOMMENDATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </label>
                          </div>

                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Sentry issue</span>
                              <input
                                value={draft.sentryIssueReference}
                                onChange={e => updateTriageDraft(ticket, { sentryIssueReference: e.target.value })}
                                placeholder="Issue ID หรือ URL จาก Sentry"
                                inputMode="url"
                                autoComplete="off"
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-violet-500/50"
                              />
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Linear issue</span>
                              <input
                                value={draft.linearIssueReference}
                                onChange={e => updateTriageDraft(ticket, { linearIssueReference: e.target.value })}
                                placeholder="HERO-123 หรือ URL จาก Linear"
                                inputMode="url"
                                autoComplete="off"
                                className="w-full rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-violet-500/50"
                              />
                            </label>
                          </div>

                          {(ticket.sentryIssueUrl || ticket.linearIssueUrl) && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {ticket.sentryIssueUrl && (
                                <a
                                  href={ticket.sentryIssueUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-200 transition-colors hover:bg-red-500/15"
                                >
                                  Sentry #{ticket.sentryIssueId} <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                              {ticket.linearIssueUrl && (
                                <a
                                  href={ticket.linearIssueUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-lg border border-violet-500/25 bg-violet-500/10 px-2 py-1 text-[10px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/15"
                                >
                                  {ticket.linearIssueIdentifier} <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          )}

                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">หลักฐาน / วิเคราะห์</span>
                              <textarea
                                value={draft.auditNote}
                                onChange={e => updateTriageDraft(ticket, { auditNote: e.target.value.slice(0, 1200) })}
                                placeholder="เช่น reproduce ได้ไหม, จากรูปเห็น error อะไร, เป็น bug จริงหรือ user เข้าใจผิด"
                                rows={4}
                                className="w-full resize-none rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-violet-500/50"
                              />
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">ผลกระทบ / server spec</span>
                              <textarea
                                value={draft.impactNote}
                                onChange={e => updateTriageDraft(ticket, { impactNote: e.target.value.slice(0, 800) })}
                                placeholder="เช่น กระทบ render, DB, disk, API cost, memory/CPU หรือเสี่ยงกับงานเก่าไหม"
                                rows={4}
                                className="w-full resize-none rounded-lg border border-[var(--ui-input-border)] bg-[var(--ui-input-bg)] px-2 py-2 text-xs text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-violet-500/50"
                              />
                            </label>
                          </div>
                        </div>

                        {/* Existing reply */}
                        {ticket.adminReply && (
                          <div className="rounded-xl p-3" style={{ background: "rgba(139,92,246,.06)", border: "1px solid rgba(167,139,250,.25)" }}>
                            <p className="text-xs mb-1 font-semibold uppercase tracking-wider" style={{ color: VIOLET_LIGHT }}>คำตอบจากทีมงาน</p>
                            <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--ui-text-secondary)" }}>{ticket.adminReply}</p>
                          </div>
                        )}

                        {/* Reply box */}
                        {ticket.status === "OPEN" && (
                          <div className="space-y-2">
                            <textarea
                              value={replyText[ticket.id] ?? ""}
                              onChange={e => setReplyText(prev => ({ ...prev, [ticket.id]: e.target.value }))}
                              placeholder="พิมพ์คำตอบ..."
                              rows={3}
                              className="w-full rounded-xl px-3 py-2 text-sm text-white placeholder:text-zinc-600 resize-none outline-none"
                              style={{ background: "var(--ui-input-bg)", border: "1px solid var(--ui-input-border)" }}
                            />
                            <div className="flex gap-2">
                              <button
                                disabled={!replyText[ticket.id]?.trim() || replying === ticket.id}
                                onClick={() => handleReply(ticket.id, false)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 transition-all hover:brightness-110"
                                style={{ background: VIOLET_GRAD, border: "1px solid transparent" }}>
                                {replying === ticket.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                                ส่งคำตอบ
                              </button>
                              <button
                                disabled={replying === ticket.id}
                                onClick={() => handleReply(ticket.id, true)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 disabled:opacity-40 transition-all hover:bg-white/5"
                                style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
                                <Clock className="h-3 w-3" />
                                {replyText[ticket.id]?.trim() ? "ส่งและปิด" : "ปิด ticket"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
