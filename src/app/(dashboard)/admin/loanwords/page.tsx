"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Trash2,
  Pencil,
  Plus,
  RotateCcw,
  Check,
  X,
  Loader2,
  Languages,
  Puzzle,
  Sparkles,
  Search,
  ShieldCheck,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
  BookOpen,
  Ban,
} from "lucide-react";
import { toast } from "sonner";

interface CompoundReviewNote {
  word: string;
  decision: "approve" | "reject" | "review";
  source: "ai" | "guard" | "human";
  reason?: string;
  at: string;
}

interface CompoundReviewSummary {
  approved: number;
  rejected: number;
  keptForReview: number;
  source: "cron" | "admin";
}

interface Data {
  words: string[];
  denylist: string[];
  lastAdded: string[];
  lastRunAt?: string | null;
  seed: string[];
  seedCount: number;
  pendingCompounds: string[];
  compounds: string[];
  autoApprovedCompounds?: string[];
  lastCompoundsFound: string[];
  lastCompoundRunAt?: string | null;
  lastCompoundReviewAt?: string | null;
  lastCompoundReviewSummary?: CompoundReviewSummary | null;
  compoundReviewLog?: CompoundReviewNote[];
  compoundSeed: string[];
  compoundSeedCount: number;
  hasGeminiKey?: boolean;
}

type SingleAction = "deny" | "restore" | "add" | "addCompound" | "edit" | "approveCompound" | "rejectCompound";
type TabId = "pending" | "active" | "denylist" | "seed";
type ActiveFilter = "all" | "loanword" | "compound" | "recent" | "ai";
type SeedFilter = "all" | "loanword" | "compound";

const PAGE_SIZE = 60;

const cardStyle: React.CSSProperties = {
  background: "var(--ui-card-bg)",
  border: "1px solid var(--ui-card-border)",
};

const thaiSegmenter =
  typeof Intl !== "undefined" && typeof (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter === "function"
    ? new Intl.Segmenter("th", { granularity: "word" })
    : null;

function icuSplitPreview(word: string): string {
  if (!thaiSegmenter) return word;
  const parts = [...thaiSegmenter.segment(word)]
    .filter((s) => (s as { isWordLike?: boolean }).isWordLike)
    .map((s) => s.segment);
  return parts.length >= 2 ? parts.join(" | ") : word;
}

function formatThaiDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminLoanwordsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [aiReviewing, setAiReviewing] = useState(false);

  // Navigation & filters
  const [tab, setTab] = useState<TabId | null>(null);
  const [pendingQuery, setPendingQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [denyQuery, setDenyQuery] = useState("");
  const [seedQuery, setSeedQuery] = useState("");
  const [seedFilter, setSeedFilter] = useState<SeedFilter>("all");

  // Pagination limits per tab so the page never becomes an endless wall
  const [pendingLimit, setPendingLimit] = useState(PAGE_SIZE);
  const [activeLimit, setActiveLimit] = useState(PAGE_SIZE);
  const [denyLimit, setDenyLimit] = useState(PAGE_SIZE);
  const [seedLimit, setSeedLimit] = useState(PAGE_SIZE);

  // Bulk selection for pending compounds
  const [selectedPending, setSelectedPending] = useState<Set<string>>(() => new Set());

  // Quick-add form & inline edit
  const [addInput, setAddInput] = useState("");
  const [addKind, setAddKind] = useState<"loanword" | "compound">("loanword");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");

  // Collapsible AI review history drawer
  const [showReviewLog, setShowReviewLog] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/loanwords");
      if (!r.ok) throw new Error(String(r.status));
      const next: Data = await r.json();
      setData(next);
      setTab((prev) => prev ?? ((next.pendingCompounds?.length ?? 0) > 0 ? "pending" : "active"));
    } catch (e) {
      toast.error("โหลดไม่สำเร็จ: " + (e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: SingleAction, word: string, newWord?: string) {
    setBusy(word);
    try {
      const r = await fetch("/api/admin/loanwords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, word, newWord }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || String(r.status));
      toast.success("บันทึกแล้ว");
      setEditing(null);
      setSelectedPending((prev) => {
        if (!prev.has(word)) return prev;
        const copy = new Set(prev);
        copy.delete(word);
        return copy;
      });
      await load();
    } catch (e) {
      toast.error("ไม่สำเร็จ: " + (e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function bulkAct(action: "bulkApproveCompounds" | "bulkRejectCompounds", words: string[]) {
    if (words.length === 0) return;
    setBusy("__bulk__");
    try {
      const r = await fetch("/api/admin/loanwords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, words }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || String(r.status));
      toast.success(
        action === "bulkApproveCompounds"
          ? `อนุมัติคำประสม ${words.length} คำแล้ว`
          : `ปฏิเสธ ${words.length} คำลง Denylist แล้ว`,
      );
      setSelectedPending(new Set());
      await load();
    } catch (e) {
      toast.error("ไม่สำเร็จ: " + (e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function runAiReview(words?: string[]) {
    setAiReviewing(true);
    try {
      const r = await fetch("/api/admin/loanwords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "aiReviewPending", ...(words && words.length > 0 ? { words } : {}) }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json?.error || String(r.status));
      const sum = json?.summary as CompoundReviewSummary | undefined;
      if (sum) {
        toast.success(
          `ตรวจเสร็จแล้ว — อนุมัติ ${sum.approved} คำ · ปฏิเสธ ${sum.rejected} คำ · เหลือรอตรวจ ${sum.keptForReview} คำ`,
        );
      } else {
        toast.success("ตรวจคำประสมเรียบร้อยแล้ว");
      }
      setSelectedPending(new Set());
      setShowReviewLog(true);
      await load();
    } catch (e) {
      toast.error("AI ตรวจไม่สำเร็จ: " + (e instanceof Error ? e.message : e));
    } finally {
      setAiReviewing(false);
    }
  }

  const reviewLogByWord = useMemo(() => {
    const map = new Map<string, CompoundReviewNote>();
    for (const note of data?.compoundReviewLog ?? []) {
      if (!map.has(note.word)) map.set(note.word, note);
    }
    return map;
  }, [data?.compoundReviewLog]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl p-6 text-sm text-zinc-400 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
        กำลังโหลดข้อมูลคำตัดซับ…
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-5xl p-6 text-sm text-red-400">โหลดข้อมูลไม่ได้</div>;
  }

  const currentTab: TabId = tab ?? (data.pendingCompounds.length > 0 ? "pending" : "active");
  const lastSet = new Set(data.lastAdded ?? []);
  const denySet = new Set(data.denylist ?? []);
  const autoApprovedSet = new Set(data.autoApprovedCompounds ?? []);

  const pendingCompounds = data.pendingCompounds ?? [];
  const approvedCompounds = data.compounds ?? [];
  const dynamicLoanwords = data.words ?? [];
  const seedActive = (data.seed ?? []).filter((w) => !denySet.has(w));
  const compoundSeedActive = (data.compoundSeed ?? []).filter((w) => !denySet.has(w));
  const reviewLog = data.compoundReviewLog ?? [];

  const totalLiveWords =
    new Set([...seedActive, ...dynamicLoanwords]).size +
    new Set([...compoundSeedActive, ...approvedCompounds]).size;

  // Filtered lists per tab
  const pendingFiltered = pendingQuery
    ? pendingCompounds.filter((w) => w.includes(pendingQuery.trim()))
    : pendingCompounds;
  const pendingShown = pendingFiltered.slice(0, pendingLimit);

  const combinedActive: { word: string; kind: "loanword" | "compound"; isRecent: boolean; isAi: boolean }[] = [
    ...approvedCompounds
      .slice()
      .reverse()
      .map((word) => ({
        word,
        kind: "compound" as const,
        isRecent: false,
        isAi: autoApprovedSet.has(word),
      })),
    ...dynamicLoanwords
      .slice()
      .reverse()
      .map((word) => ({
        word,
        kind: "loanword" as const,
        isRecent: lastSet.has(word),
        isAi: false,
      })),
  ];

  const activeFiltered = combinedActive.filter((item) => {
    if (activeFilter === "loanword" && item.kind !== "loanword") return false;
    if (activeFilter === "compound" && item.kind !== "compound") return false;
    if (activeFilter === "recent" && !item.isRecent) return false;
    if (activeFilter === "ai" && !item.isAi) return false;
    if (activeQuery && !item.word.includes(activeQuery.trim())) return false;
    return true;
  });
  const activeShown = activeFiltered.slice(0, activeLimit);

  const denyFiltered = (denyQuery
    ? data.denylist.filter((w) => w.includes(denyQuery.trim()))
    : data.denylist
  )
    .slice()
    .reverse();
  const denyShown = denyFiltered.slice(0, denyLimit);

  const seedCombined: { word: string; kind: "loanword" | "compound" }[] = [
    ...(seedFilter !== "compound" ? seedActive.map((word) => ({ word, kind: "loanword" as const })) : []),
    ...(seedFilter !== "loanword" ? compoundSeedActive.map((word) => ({ word, kind: "compound" as const })) : []),
  ];
  const seedFiltered = seedQuery
    ? seedCombined.filter((item) => item.word.includes(seedQuery.trim()))
    : seedCombined;
  const seedShown = seedFiltered.slice(0, seedLimit);

  const selectedInFiltered = [...selectedPending].filter((w) => pendingCompounds.includes(w));

  function toggleSelectPending(word: string) {
    setSelectedPending((prev) => {
      const next = new Set(prev);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
  }

  function selectAllVisiblePending() {
    setSelectedPending((prev) => {
      const next = new Set(prev);
      for (const w of pendingShown) next.add(w);
      return next;
    });
  }

  function handleAddSubmit() {
    const w = addInput.trim();
    if (!w) return;
    setAddInput("");
    void act(addKind === "compound" ? "addCompound" : "add", w);
  }

  const lastRunLabel = formatThaiDateTime(data.lastRunAt);
  const lastReviewLabel = formatThaiDateTime(data.lastCompoundReviewAt);

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-5">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Languages className="h-5 w-5 text-violet-400" />
            <h1 className="text-xl font-semibold text-white">จัดการคำตัดซับ &amp; คำประสม</h1>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            ซิงก์อัตโนมัติไปที่ MCP Worker · Web Editor V2 · Remotion Render (กัน ICU/Chromium ตัดกลางคำตอนแบ่งการ์ดและขึ้นบรรทัดใหม่)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
          {lastRunLabel && (
            <span className="rounded-full border border-zinc-800 bg-zinc-900/70 px-2.5 py-1">
              Cron ล่าสุด: {lastRunLabel}
            </span>
          )}
          {lastReviewLabel && (
            <span className="rounded-full border border-violet-500/25 bg-violet-500/10 px-2.5 py-1 text-violet-200">
              AI ตรวจล่าสุด: {lastReviewLabel}
            </span>
          )}
        </div>
      </div>

      {/* ── KPI Summary Strip ──────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => setTab("active")}
          style={cardStyle}
          className="rounded-xl p-3.5 text-left transition hover:border-violet-500/40"
        >
          <div className="text-[11px] text-zinc-400">คำที่ใช้งานจริงทั้งหมด</div>
          <div className="mt-1 text-2xl font-semibold text-white tabular-nums">{totalLiveWords.toLocaleString()}</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            Seed {seedActive.length + compoundSeedActive.length} · Dynamic {dynamicLoanwords.length + approvedCompounds.length}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setTab("pending")}
          style={
            pendingCompounds.length > 0
              ? { background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.35)" }
              : cardStyle
          }
          className="rounded-xl p-3.5 text-left transition hover:border-amber-400/60"
        >
          <div className="flex items-center justify-between text-[11px] text-amber-300/90">
            <span>คำประสมรอตรวจ</span>
            <Puzzle className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <div className="mt-1 text-2xl font-semibold text-white tabular-nums">{pendingCompounds.length.toLocaleString()}</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            {pendingCompounds.length > 0 ? "กดให้ AI ตรวจอัตโนมัติได้" : "คิวว่างแล้ว"}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setTab("active")}
          style={cardStyle}
          className="rounded-xl p-3.5 text-left transition hover:border-violet-500/40"
        >
          <div className="text-[11px] text-zinc-400">คำ Dynamic ใน DB</div>
          <div className="mt-1 text-2xl font-semibold text-white tabular-nums">
            {(dynamicLoanwords.length + approvedCompounds.length).toLocaleString()}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            ทับศัพท์ {dynamicLoanwords.length} · คำประสม {approvedCompounds.length}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setTab("denylist")}
          style={cardStyle}
          className="rounded-xl p-3.5 text-left transition hover:border-red-500/40"
        >
          <div className="text-[11px] text-zinc-400">Denylist (ห้ามกัน)</div>
          <div className="mt-1 text-2xl font-semibold text-white tabular-nums">{data.denylist.length.toLocaleString()}</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">ป้องกัน cron เสนอซ้ำ</div>
        </button>
      </div>

      {/* ── Navigation Tabs ────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1.5 border-b border-zinc-800 pb-2">
        {(
          [
            {
              id: "pending" as const,
              label: "คำประสมรอตรวจ",
              count: pendingCompounds.length,
              icon: Sparkles,
              accent: pendingCompounds.length > 0 ? "amber" : "default",
            },
            {
              id: "active" as const,
              label: "คำที่ระบบใช้งาน (Dynamic)",
              count: dynamicLoanwords.length + approvedCompounds.length,
              icon: ShieldCheck,
              accent: "default",
            },
            {
              id: "denylist" as const,
              label: "Denylist",
              count: data.denylist.length,
              icon: Ban,
              accent: "default",
            },
            {
              id: "seed" as const,
              label: "Seed ในโค้ด",
              count: seedActive.length + compoundSeedActive.length,
              icon: BookOpen,
              accent: "default",
            },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = currentTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition ${
                active
                  ? "bg-violet-600/20 text-white border border-violet-500/50"
                  : "text-zinc-400 border border-transparent hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <Icon className={`h-3.5 w-3.5 ${active ? "text-violet-300" : "text-zinc-500"}`} />
              <span>{item.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                  item.accent === "amber"
                    ? "bg-amber-500/25 text-amber-200"
                    : active
                      ? "bg-violet-500/30 text-violet-100"
                      : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {item.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ══════════════════════════════════════════════════════════
          TAB 1: PENDING COMPOUNDS + AI AUTO-REVIEW
      ══════════════════════════════════════════════════════════ */}
      {currentTab === "pending" && (
        <div className="space-y-4">
          {/* AI Review Action Card */}
          <section
            style={{
              background: "linear-gradient(135deg, rgba(139, 92, 246, 0.12), rgba(24, 24, 27, 0.85))",
              border: "1px solid rgba(139, 92, 246, 0.35)",
            }}
            className="rounded-xl p-4 space-y-3"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Sparkles className="h-4 w-4 text-violet-300" />
                  ระบบตรวจและอนุมัติคำประสมอัตโนมัติ (Safety Guard + AI Review)
                </div>
                <p className="text-xs text-zinc-300/80 leading-relaxed">
                  ทุกคืน cron จะคัดกรองด้วย <b>Safety Guard</b> (กันคำเชื่อม/คำเจอบ่อยที่เสี่ยงรวมข้ามคำ) แล้วให้{" "}
                  <b>AI ตรวจแทน</b> — คำที่ชัวร์จะถูก <b>อนุมัติอัตโนมัติ</b>, คำเสี่ยงถูก <b>ปฏิเสธลง Denylist</b>,
                  เหลือไว้หน้านี้เฉพาะคำก้ำกึ่งจริง ๆ (ทุกคำที่ AI อนุมัติสามารถกดถอนย้อนหลังได้)
                </p>
                {data.lastCompoundReviewSummary && (
                  <p className="text-[11px] text-violet-200/90">
                    ผลตรวจรอบล่าสุด ({data.lastCompoundReviewSummary.source === "admin" ? "กดตรวจเอง" : "Cron"}):{" "}
                    อนุมัติ {data.lastCompoundReviewSummary.approved} · ปฏิเสธ {data.lastCompoundReviewSummary.rejected} ·
                    เหลือรอตรวจ {data.lastCompoundReviewSummary.keptForReview}
                  </p>
                )}
                {data.hasGeminiKey === false && (
                  <p className="text-[11px] text-amber-300">
                    หมายเหตุ: ยังไม่ได้ตั้งค่า Server Gemini Key — ปุ่มนี้จะรันเฉพาะ Safety Guard (คัดคำเสี่ยงออก) และเก็บคำที่ปลอดภัยไว้ให้กดยืนยัน
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {selectedInFiltered.length > 0 && (
                  <button
                    type="button"
                    disabled={aiReviewing || busy !== null}
                    onClick={() => void runAiReview(selectedInFiltered)}
                    className="flex items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-100 hover:bg-violet-500/25 disabled:opacity-40"
                  >
                    {aiReviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    ให้ AI ตรวจที่เลือก ({selectedInFiltered.length})
                  </button>
                )}
                <button
                  type="button"
                  disabled={aiReviewing || busy !== null || pendingCompounds.length === 0}
                  onClick={() => void runAiReview()}
                  className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-violet-500 disabled:opacity-40"
                >
                  {aiReviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {aiReviewing
                    ? "กำลังให้ AI ตรวจคิวค้าง…"
                    : `ให้ AI ตรวจคิวค้างทั้งหมด (${pendingCompounds.length})`}
                </button>
              </div>
            </div>
          </section>

          {/* Pending Queue List */}
          <section style={cardStyle} className="rounded-xl p-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  value={pendingQuery}
                  onChange={(e) => {
                    setPendingQuery(e.target.value);
                    setPendingLimit(PAGE_SIZE);
                  }}
                  placeholder="ค้นหาคำประสมรอตรวจ…"
                  className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 outline-none focus:border-violet-500/60"
                />
              </div>

              {pendingShown.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={
                      selectedInFiltered.length === pendingShown.length && pendingShown.length > 0
                        ? () => setSelectedPending(new Set())
                        : selectAllVisiblePending
                    }
                    className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-white"
                  >
                    {selectedInFiltered.length > 0 ? <CheckSquare className="h-3.5 w-3.5 text-violet-400" /> : <Square className="h-3.5 w-3.5" />}
                    {selectedInFiltered.length > 0 ? `เลือกอยู่ ${selectedInFiltered.length}` : `เลือก ${pendingShown.length} คำนี้`}
                  </button>

                  {selectedInFiltered.length > 0 && (
                    <>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void bulkAct("bulkApproveCompounds", selectedInFiltered)}
                        className="flex items-center gap-1 rounded-lg bg-emerald-600/20 border border-emerald-500/40 px-2.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-40"
                      >
                        <Check className="h-3.5 w-3.5" /> อนุมัติ ({selectedInFiltered.length})
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void bulkAct("bulkRejectCompounds", selectedInFiltered)}
                        className="flex items-center gap-1 rounded-lg bg-red-600/15 border border-red-500/35 px-2.5 py-1.5 text-xs font-medium text-red-200 hover:bg-red-600/25 disabled:opacity-40"
                      >
                        <X className="h-3.5 w-3.5" /> ปฏิเสธ ({selectedInFiltered.length})
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {pendingCompounds.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-800 py-8 text-center text-xs text-zinc-500">
                ไม่มีคำประสมรอตรวจแล้ว — ระบบจะคัดกรองอัตโนมัติในรอบ cron ถัดไป
              </div>
            ) : pendingShown.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-500">ไม่พบ &quot;{pendingQuery}&quot;</p>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {pendingShown.map((w) => {
                    const checked = selectedPending.has(w);
                    const note = reviewLogByWord.get(w);
                    const splitHint = icuSplitPreview(w);
                    return (
                      <div
                        key={w}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 transition ${
                          checked
                            ? "border-violet-500/60 bg-violet-500/10"
                            : "border-zinc-800 bg-zinc-900/70 hover:border-zinc-700"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSelectPending(w)}
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        >
                          <span className="mt-0.5 text-zinc-400">
                            {checked ? <CheckSquare className="h-3.5 w-3.5 text-violet-400" /> : <Square className="h-3.5 w-3.5" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-sm text-white">{w}</span>
                            <span className="block truncate text-[11px] text-zinc-500">
                              ICU: {splitHint}
                            </span>
                            {note?.reason && (
                              <span className="mt-0.5 block truncate text-[10px] text-amber-300/80" title={note.reason}>
                                {note.reason}
                              </span>
                            )}
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            disabled={busy === w || busy === "__bulk__"}
                            onClick={() => void act("approveCompound", w)}
                            title="อนุมัติ (เอาไปกันคำจริง)"
                            className="rounded-md p-1.5 text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-40"
                          >
                            {busy === w ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            type="button"
                            disabled={busy === w || busy === "__bulk__"}
                            onClick={() => void act("rejectCompound", w)}
                            title="ปฏิเสธ (ใส่ Denylist)"
                            className="rounded-md p-1.5 text-red-400 hover:bg-red-500/15 disabled:opacity-40"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {pendingFiltered.length > pendingShown.length && (
                  <div className="flex items-center justify-between pt-2 text-xs text-zinc-400">
                    <span>
                      แสดง {pendingShown.length} จาก {pendingFiltered.length} คำ
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingLimit((n) => n + PAGE_SIZE)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:border-violet-500/50"
                    >
                      แสดงเพิ่มอีก {Math.min(PAGE_SIZE, pendingFiltered.length - pendingShown.length)} คำ
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Collapsible AI Review Log */}
          {reviewLog.length > 0 && (
            <section style={cardStyle} className="rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => setShowReviewLog((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium text-zinc-200 hover:bg-zinc-900/50"
              >
                <span className="flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5 text-violet-400" />
                  ประวัติการตัดสินของ AI / Safety Guard ล่าสุด ({reviewLog.length} คำ) — กดถอนหรือคืนค่าได้ทันที
                </span>
                {showReviewLog ? <ChevronUp className="h-4 w-4 text-zinc-400" /> : <ChevronDown className="h-4 w-4 text-zinc-400" />}
              </button>

              {showReviewLog && (
                <div className="border-t border-zinc-800/80 divide-y divide-zinc-800/60 max-h-96 overflow-y-auto">
                  {reviewLog.slice(0, 80).map((note) => {
                    const isCurrentlyApproved = approvedCompounds.includes(note.word);
                    const isCurrentlyDenied = denySet.has(note.word);
                    return (
                      <div key={`${note.word}-${note.at}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-white">{note.word}</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                note.decision === "approve"
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : note.decision === "reject"
                                    ? "bg-red-500/20 text-red-300"
                                    : "bg-amber-500/20 text-amber-200"
                              }`}
                            >
                              {note.decision === "approve"
                                ? "AI อนุมัติ"
                                : note.decision === "reject"
                                  ? note.source === "guard"
                                    ? "Safety Guard ปฏิเสธ"
                                    : "AI ปฏิเสธ"
                                  : "ก้ำกึ่ง"}
                            </span>
                            {note.reason && <span className="truncate text-zinc-400">{note.reason}</span>}
                          </div>
                        </div>

                        <div className="shrink-0">
                          {isCurrentlyApproved && (
                            <button
                              type="button"
                              disabled={busy === note.word}
                              onClick={() => void act("rejectCompound", note.word)}
                              className="rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15 disabled:opacity-40"
                            >
                              ถอนออก
                            </button>
                          )}
                          {isCurrentlyDenied && (
                            <button
                              type="button"
                              disabled={busy === note.word}
                              onClick={() => void act("approveCompound", note.word)}
                              className="rounded border border-emerald-500/30 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-40"
                            >
                              อนุมัติแทน
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          TAB 2: ACTIVE DYNAMIC WORDS (LOANWORDS + APPROVED COMPOUNDS)
      ══════════════════════════════════════════════════════════ */}
      {currentTab === "active" && (
        <section style={cardStyle} className="rounded-xl p-4 space-y-4">
          {/* Quick-Add Bar */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="inline-flex rounded-lg border border-zinc-700/80 bg-zinc-900 p-0.5 text-xs shrink-0">
              <button
                type="button"
                onClick={() => setAddKind("loanword")}
                className={`rounded-md px-2.5 py-1.5 font-medium transition ${
                  addKind === "loanword" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                คำทับศัพท์
              </button>
              <button
                type="button"
                onClick={() => setAddKind("compound")}
                className={`rounded-md px-2.5 py-1.5 font-medium transition ${
                  addKind === "compound" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                คำประสม
              </button>
            </div>
            <input
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddSubmit();
              }}
              placeholder={addKind === "compound" ? "เพิ่มคำประสมตรง ๆ เช่น เพื่อนร่วมงาน" : "เพิ่มคำทับศัพท์ตรง ๆ เช่น คอนเทนต์"}
              className="flex-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-1.5 text-xs text-white placeholder-zinc-500 outline-none focus:border-violet-500/60"
            />
            <button
              type="button"
              disabled={!addInput.trim() || busy === addInput.trim()}
              onClick={handleAddSubmit}
              className="flex items-center justify-center gap-1 rounded-lg bg-violet-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> เพิ่มคำ
            </button>
          </div>

          {/* Filters + Search */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { id: "all" as const, label: `ทั้งหมด (${combinedActive.length})` },
                  { id: "loanword" as const, label: `คำทับศัพท์ (${dynamicLoanwords.length})` },
                  { id: "compound" as const, label: `คำประสม (${approvedCompounds.length})` },
                  { id: "ai" as const, label: `AI อนุมัติ (${autoApprovedSet.size})` },
                  { id: "recent" as const, label: `ใหม่รอบล่าสุด (${lastSet.size})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setActiveFilter(f.id);
                    setActiveLimit(PAGE_SIZE);
                  }}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                    activeFilter === f.id
                      ? "bg-violet-600/25 text-violet-100 border border-violet-500/50"
                      : "bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                value={activeQuery}
                onChange={(e) => {
                  setActiveQuery(e.target.value);
                  setActiveLimit(PAGE_SIZE);
                }}
                placeholder="ค้นหาคำ…"
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 outline-none focus:border-violet-500/60"
              />
            </div>
          </div>

          {/* Active Words Chips */}
          {activeShown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 py-8 text-center text-xs text-zinc-500">
              {activeQuery ? `ไม่พบ "${activeQuery}"` : "ยังไม่มีคำในหมวดนี้"}
            </div>
          ) : (
            <>
              <ul className="flex flex-wrap gap-2">
                {activeShown.map(({ word: w, kind, isRecent, isAi }) => (
                  <li
                    key={`${kind}-${w}`}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs text-white ${
                      isRecent || isAi
                        ? "border-violet-500/45 bg-violet-500/10"
                        : "border-zinc-700/80 bg-zinc-900/80"
                    }`}
                  >
                    {editing === w && kind === "loanword" ? (
                      <>
                        <input
                          value={editVal}
                          onChange={(e) => setEditVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && editVal.trim()) void act("edit", w, editVal.trim());
                            if (e.key === "Escape") setEditing(null);
                          }}
                          autoFocus
                          className="w-28 rounded border border-zinc-600 bg-zinc-950 px-1.5 py-0.5 text-xs text-white outline-none"
                        />
                        <button
                          type="button"
                          disabled={busy === w || !editVal.trim()}
                          onClick={() => void act("edit", w, editVal.trim())}
                          className="text-emerald-400 disabled:opacity-40"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => setEditing(null)} className="text-zinc-400">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-[13px]">{w}</span>
                        {kind === "compound" && (
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">ประสม</span>
                        )}
                        {isAi && (
                          <span className="rounded bg-violet-500/25 px-1.5 py-0.5 text-[10px] text-violet-200">AI อนุมัติ</span>
                        )}
                        {isRecent && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-200">ใหม่</span>
                        )}
                        {kind === "loanword" && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(w);
                              setEditVal(w);
                            }}
                            title="แก้ไขสะกด"
                            className="text-zinc-400 hover:text-white"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy === w}
                          onClick={() => void act(kind === "compound" ? "rejectCompound" : "deny", w)}
                          title="ถอนออก (ย้ายไป Denylist)"
                          className="text-red-400/80 hover:text-red-300 disabled:opacity-40"
                        >
                          {busy === w ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>

              {activeFiltered.length > activeShown.length && (
                <div className="flex items-center justify-between pt-2 text-xs text-zinc-400">
                  <span>
                    แสดง {activeShown.length} จาก {activeFiltered.length} คำ
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveLimit((n) => n + PAGE_SIZE)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:border-violet-500/50"
                  >
                    แสดงเพิ่มอีก {Math.min(PAGE_SIZE, activeFiltered.length - activeShown.length)} คำ
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ══════════════════════════════════════════════════════════
          TAB 3: DENYLIST
      ══════════════════════════════════════════════════════════ */}
      {currentTab === "denylist" && (
        <section style={cardStyle} className="rounded-xl p-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-zinc-400">
              คำที่ถูกปฏิเสธหรือถอนออก ระบบจะไม่กันคำและ cron จะไม่เสนอซ้ำ (กดคืนค่าเพื่อปลดบล็อก)
            </p>
            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                value={denyQuery}
                onChange={(e) => {
                  setDenyQuery(e.target.value);
                  setDenyLimit(PAGE_SIZE);
                }}
                placeholder="ค้นหาใน Denylist…"
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 outline-none focus:border-violet-500/60"
              />
            </div>
          </div>

          {denyShown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 py-8 text-center text-xs text-zinc-500">
              {denyQuery ? `ไม่พบ "${denyQuery}"` : "Denylist ว่าง"}
            </div>
          ) : (
            <>
              <ul className="flex flex-wrap gap-2">
                {denyShown.map((w) => {
                  const note = reviewLogByWord.get(w);
                  return (
                    <li
                      key={w}
                      title={note?.reason || undefined}
                      className="flex items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-100"
                    >
                      <span className="font-mono text-[13px]">{w}</span>
                      <button
                        type="button"
                        disabled={busy === w}
                        onClick={() => void act("restore", w)}
                        title="คืนค่า (เอาออกจาก Denylist)"
                        className="text-zinc-300 hover:text-white disabled:opacity-40"
                      >
                        {busy === w ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {denyFiltered.length > denyShown.length && (
                <div className="flex items-center justify-between pt-2 text-xs text-zinc-400">
                  <span>
                    แสดง {denyShown.length} จาก {denyFiltered.length} คำ
                  </span>
                  <button
                    type="button"
                    onClick={() => setDenyLimit((n) => n + PAGE_SIZE)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:border-violet-500/50"
                  >
                    แสดงเพิ่มอีก {Math.min(PAGE_SIZE, denyFiltered.length - denyShown.length)} คำ
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ══════════════════════════════════════════════════════════
          TAB 4: STATIC SEED (IN-CODE)
      ══════════════════════════════════════════════════════════ */}
      {currentTab === "seed" && (
        <section style={cardStyle} className="rounded-xl p-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: "all" as const, label: `ทั้งหมด (${seedActive.length + compoundSeedActive.length})` },
                  { id: "loanword" as const, label: `คำทับศัพท์ (${seedActive.length})` },
                  { id: "compound" as const, label: `คำประสม (${compoundSeedActive.length})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setSeedFilter(f.id);
                    setSeedLimit(PAGE_SIZE);
                  }}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                    seedFilter === f.id
                      ? "bg-violet-600/25 text-violet-100 border border-violet-500/50"
                      : "bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                value={seedQuery}
                onChange={(e) => {
                  setSeedQuery(e.target.value);
                  setSeedLimit(PAGE_SIZE);
                }}
                placeholder="ค้นหาคำใน Seed…"
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 outline-none focus:border-violet-500/60"
              />
            </div>
          </div>

          <p className="text-[11px] text-zinc-500">
            คำมาตรฐานที่ฝังอยู่ในโค้ดและทำงานทุกที่เสมอ — กดถังขยะเพื่อ override ยกเลิกผ่าน Denylist ได้ทันที
          </p>

          {seedShown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 py-8 text-center text-xs text-zinc-500">
              {seedQuery ? `ไม่พบ "${seedQuery}"` : "ว่าง"}
            </div>
          ) : (
            <>
              <ul className="flex flex-wrap gap-1.5">
                {seedShown.map(({ word: w, kind }) => (
                  <li
                    key={`${kind}-${w}`}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300"
                  >
                    <span className="font-mono text-[13px]">{w}</span>
                    {kind === "compound" && (
                      <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">ประสม</span>
                    )}
                    <button
                      type="button"
                      disabled={busy === w}
                      onClick={() => void act(kind === "compound" ? "rejectCompound" : "deny", w)}
                      title="ถอน (override ผ่าน Denylist)"
                      className="text-red-400/60 hover:text-red-300 disabled:opacity-40"
                    >
                      {busy === w ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    </button>
                  </li>
                ))}
              </ul>

              {seedFiltered.length > seedShown.length && (
                <div className="flex items-center justify-between pt-2 text-xs text-zinc-400">
                  <span>
                    แสดง {seedShown.length} จาก {seedFiltered.length} คำ
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSeedLimit((n) => n + PAGE_SIZE)}
                      className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:border-violet-500/50"
                    >
                      แสดงเพิ่มอีก {Math.min(PAGE_SIZE, seedFiltered.length - seedShown.length)} คำ
                    </button>
                    <button
                      type="button"
                      onClick={() => setSeedLimit(seedFiltered.length)}
                      className="rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      แสดงทั้งหมด
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
