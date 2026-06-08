"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Bug,
  CheckCircle2,
  Eye,
  Loader2,
  Megaphone,
  Pencil,
  Pin,
  Rocket,
  Save,
  Send,
  Sparkles,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type UpdateCategory = "FEATURE" | "IMPROVEMENT" | "FIX" | "PATCH" | "KNOWN_ISSUE" | "IN_PROGRESS";
type UpdateState = "DRAFT" | "PUBLISHED" | "ARCHIVED";
type UpdateImportance = "SILENT" | "BANNER" | "MODAL";

type AdminUpdate = {
  id: string;
  version: string;
  title: string;
  summary: string;
  body: string | null;
  category: UpdateCategory;
  importance: UpdateImportance;
  state: UpdateState;
  isPinned: boolean;
  targetPath: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  readCount: number;
};

type FormState = {
  id: string | null;
  version: string;
  title: string;
  summary: string;
  body: string;
  category: UpdateCategory;
  importance: UpdateImportance;
  state: UpdateState;
  isPinned: boolean;
  targetPath: string;
  ctaLabel: string;
  ctaHref: string;
  imageUrl: string;
};

const emptyForm: FormState = {
  id: null,
  version: "v0.4.2",
  title: "",
  summary: "",
  body: "",
  category: "PATCH",
  importance: "BANNER",
  state: "DRAFT",
  isPinned: false,
  targetPath: "/video-editor",
  ctaLabel: "เปิด Video Editor",
  ctaHref: "",
  imageUrl: "",
};

const categoryOptions: { value: UpdateCategory; label: string; icon: React.ElementType }[] = [
  { value: "FEATURE", label: "Feature", icon: Sparkles },
  { value: "IMPROVEMENT", label: "Improvement", icon: Rocket },
  { value: "FIX", label: "Fix", icon: Bug },
  { value: "PATCH", label: "Patch", icon: CheckCircle2 },
  { value: "KNOWN_ISSUE", label: "Known issue", icon: Megaphone },
  { value: "IN_PROGRESS", label: "In progress", icon: Wrench },
];

const importanceOptions: { value: UpdateImportance; label: string; description: string }[] = [
  { value: "BANNER", label: "Banner", description: "โชว์แถบแจ้งเตือนบน Dashboard และ Video Editor" },
  { value: "MODAL", label: "Modal", description: "เด้งเป็นประกาศสำคัญครั้งเดียว เหมาะกับ incident หรือ breaking change" },
  { value: "SILENT", label: "Silent", description: "เก็บไว้ในหน้า Updates อย่างเดียว ไม่ดึงสายตา user" },
];

function toForm(update: AdminUpdate): FormState {
  return {
    id: update.id,
    version: update.version,
    title: update.title,
    summary: update.summary,
    body: update.body ?? "",
    category: update.category,
    importance: update.importance,
    state: update.state,
    isPinned: update.isPinned,
    targetPath: update.targetPath ?? "",
    ctaLabel: update.ctaLabel ?? "",
    ctaHref: update.ctaHref ?? "",
    imageUrl: update.imageUrl ?? "",
  };
}

function stateTone(state: UpdateState) {
  if (state === "PUBLISHED") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200";
  if (state === "ARCHIVED") return "border-slate-400/20 bg-slate-400/10 text-slate-300";
  return "border-amber-400/25 bg-amber-400/10 text-amber-200";
}

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export default function AdminUpdatesPage() {
  const [updates, setUpdates] = useState<AdminUpdate[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stateFilter, setStateFilter] = useState<"ALL" | UpdateState>("ALL");

  useEffect(() => {
    fetchUpdates();
  }, []);

  async function fetchUpdates() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/updates", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "โหลด updates ไม่ได้");
      setUpdates(body.updates ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "โหลด updates ไม่ได้");
    } finally {
      setLoading(false);
    }
  }

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save(nextState?: UpdateState) {
    if (!form.version.trim() || !form.title.trim() || !form.summary.trim()) {
      toast.error("กรอก version, title, summary ก่อน");
      return;
    }
    setSaving(true);
    const payload = { ...form, state: nextState ?? form.state };
    const method = form.id ? "PATCH" : "POST";
    const url = form.id ? `/api/admin/updates/${form.id}` : "/api/admin/updates";
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "บันทึกไม่สำเร็จ");
      toast.success((nextState ?? form.state) === "PUBLISHED" ? "เผยแพร่ update แล้ว" : "บันทึก update แล้ว");
      setForm(emptyForm);
      await fetchUpdates();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function archive(update: AdminUpdate) {
    if (!confirm(`Archive "${update.title}"?`)) return;
    try {
      const res = await fetch(`/api/admin/updates/${update.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("archive ไม่สำเร็จ");
      toast.success("Archive แล้ว");
      await fetchUpdates();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "archive ไม่สำเร็จ");
    }
  }

  const visibleUpdates = useMemo(() => {
    if (stateFilter === "ALL") return updates;
    return updates.filter((update) => update.state === stateFilter);
  }, [updates, stateFilter]);

  const publishedCount = updates.filter((update) => update.state === "PUBLISHED").length;

  return (
    <main className="min-h-screen bg-[#080b12] px-4 py-5 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-md border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-200">
              <Megaphone className="h-3.5 w-3.5" />
              Release Notes Console
            </div>
            <h1 className="text-2xl font-semibold tracking-normal text-white sm:text-3xl">จัดการ Updates</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
              เขียนประกาศแบบ user-facing: version, สิ่งที่แก้แล้ว, สิ่งที่กำลังติดตาม และ CTA ไปยังหน้าที่เกี่ยวข้อง
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:min-w-[320px]">
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
              <div className="text-xs text-slate-500">Published</div>
              <div className="mt-1 text-2xl font-semibold text-white">{publishedCount}</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3">
              <div className="text-xs text-slate-500">All entries</div>
              <div className="mt-1 text-2xl font-semibold text-white">{updates.length}</div>
            </div>
          </div>
        </header>

        <section className="grid gap-5 xl:grid-cols-[440px_1fr]">
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-white">{form.id ? "แก้ไข update" : "สร้าง update"}</h2>
              {form.id && (
                <button
                  type="button"
                  onClick={() => setForm(emptyForm)}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
                >
                  สร้างใหม่
                </button>
              )}
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-[120px_1fr] gap-3">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">Version</span>
                  <input
                    value={form.version}
                    onChange={(event) => updateForm("version", event.target.value)}
                    className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-sky-400/50"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">Title</span>
                  <input
                    value={form.title}
                    onChange={(event) => updateForm("title", event.target.value)}
                    placeholder="B-roll Stability Patch"
                    className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-sky-400/50"
                  />
                </label>
              </div>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-slate-500">Summary</span>
                <textarea
                  value={form.summary}
                  onChange={(event) => updateForm("summary", event.target.value)}
                  rows={3}
                  placeholder="แก้ปัญหา B-roll ที่ช้าในบางเคส และเพิ่ม queue เพื่อให้ระบบไม่ล่มเมื่อมีหลายงานพร้อมกัน"
                  className="w-full resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm leading-relaxed text-white outline-none placeholder:text-slate-600 focus:border-sky-400/50"
                />
              </label>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-slate-500">Details</span>
                <textarea
                  value={form.body}
                  onChange={(event) => updateForm("body", event.target.value)}
                  rows={7}
                  placeholder={"แก้แล้ว:\n- จำกัดการ download/normalize B-roll\n- เพิ่ม telemetry เพื่อ monitor งานจริง\n\nกำลังติดตาม:\n- เวลา render หลังมีหลาย user ใช้งานพร้อมกัน"}
                  className="w-full resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm leading-relaxed text-white outline-none placeholder:text-slate-600 focus:border-sky-400/50"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">Category</span>
                  <select
                    value={form.category}
                    onChange={(event) => updateForm("category", event.target.value as UpdateCategory)}
                    className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-sky-400/50"
                  >
                    {categoryOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">Importance</span>
                  <select
                    value={form.importance}
                    onChange={(event) => updateForm("importance", event.target.value as UpdateImportance)}
                    className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-sky-400/50"
                  >
                    {importanceOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <span className="block text-[11px] leading-snug text-slate-600">
                    {importanceOptions.find((option) => option.value === form.importance)?.description}
                  </span>
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">State</span>
                  <select
                    value={form.state}
                    onChange={(event) => updateForm("state", event.target.value as UpdateState)}
                    className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-sky-400/50"
                  >
                    <option value="DRAFT">Draft</option>
                    <option value="PUBLISHED">Published</option>
                    <option value="ARCHIVED">Archived</option>
                  </select>
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">CTA label</span>
                  <input
                    value={form.ctaLabel}
                    onChange={(event) => updateForm("ctaLabel", event.target.value)}
                    className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-sky-400/50"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-500">CTA href</span>
                  <input
                    value={form.ctaHref}
                    onChange={(event) => updateForm("ctaHref", event.target.value)}
                    placeholder="/video-editor"
                    className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-sky-400/50"
                  />
                </label>
              </div>

              <label className="space-y-1.5">
                <span className="text-xs font-medium text-slate-500">Target path</span>
                <input
                  value={form.targetPath}
                  onChange={(event) => updateForm("targetPath", event.target.value)}
                  placeholder="/video-editor"
                  className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-sky-400/50"
                />
              </label>

              <label className="flex items-center justify-between rounded-md border border-white/10 bg-black/20 px-3 py-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <Pin className="h-4 w-4 text-amber-300" />
                  Pin เป็น update สำคัญ
                </span>
                <input
                  type="checkbox"
                  checked={form.isPinned}
                  onChange={(event) => updateForm("isPinned", event.target.checked)}
                  className="h-4 w-4"
                />
              </label>

              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save("DRAFT")}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold text-white transition hover:bg-white/[0.08] disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save draft
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save("PUBLISHED")}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-white px-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-200 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Publish
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold text-white">Update history</h2>
              <div className="inline-flex rounded-md border border-white/10 bg-black/20 p-1">
                {(["ALL", "DRAFT", "PUBLISHED", "ARCHIVED"] as const).map((state) => (
                  <button
                    key={state}
                    type="button"
                    onClick={() => setStateFilter(state)}
                    className={cn(
                      "rounded px-2.5 py-1.5 text-xs font-semibold transition",
                      stateFilter === state ? "bg-white text-slate-950" : "text-slate-400 hover:bg-white/10 hover:text-white",
                    )}
                  >
                    {state}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="flex h-72 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-sky-300" />
              </div>
            ) : visibleUpdates.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-black/20 p-8 text-center text-sm text-slate-500">
                ยังไม่มี update ในหมวดนี้
              </div>
            ) : (
              <div className="divide-y divide-white/10">
                {visibleUpdates.map((update) => {
                  const meta = categoryOptions.find((item) => item.value === update.category) ?? categoryOptions[1];
                  const Icon = meta.icon;
                  return (
                    <div key={update.id} className="grid gap-3 py-4 lg:grid-cols-[1fr_170px] lg:items-center">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold", stateTone(update.state))}>
                            {update.state}
                          </span>
                          <span className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs font-semibold text-slate-300">
                            <Icon className="h-3.5 w-3.5" />
                            {meta.label}
                          </span>
                          <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs font-semibold text-slate-300">
                            {update.version}
                          </span>
                          <span className={cn(
                            "rounded-md border px-2 py-1 text-xs font-semibold",
                            update.importance === "MODAL"
                              ? "border-rose-400/25 bg-rose-400/10 text-rose-200"
                              : update.importance === "BANNER"
                                ? "border-sky-400/25 bg-sky-400/10 text-sky-200"
                                : "border-slate-400/20 bg-slate-400/10 text-slate-300",
                          )}>
                            {update.importance}
                          </span>
                          {update.isPinned && <Pin className="h-3.5 w-3.5 text-amber-300" />}
                        </div>
                        <h3 className="mt-2 truncate text-base font-semibold text-white">{update.title}</h3>
                        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-slate-400">{update.summary}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                          <span>published {formatDate(update.publishedAt)}</span>
                          <span className="inline-flex items-center gap-1">
                            <Eye className="h-3.5 w-3.5" />
                            read {update.readCount}
                          </span>
                        </div>
                      </div>

                      <div className="flex gap-2 lg:justify-end">
                        <button
                          type="button"
                          onClick={() => setForm(toForm(update))}
                          className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10"
                        >
                          <Pencil className="h-4 w-4" />
                          Edit
                        </button>
                        {update.state !== "ARCHIVED" && (
                          <button
                            type="button"
                            onClick={() => archive(update)}
                            className="inline-flex h-9 items-center gap-2 rounded-md border border-rose-400/20 px-3 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/10"
                          >
                            <Archive className="h-4 w-4" />
                            Archive
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
