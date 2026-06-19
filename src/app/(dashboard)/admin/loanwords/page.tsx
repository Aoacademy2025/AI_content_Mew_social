"use client";

import { useEffect, useState, useCallback } from "react";
import { Trash2, Pencil, Plus, RotateCcw, Check, X, Loader2, Languages } from "lucide-react";
import { toast } from "sonner";

interface Data { words: string[]; denylist: string[]; lastAdded: string[]; seed: string[]; seedCount: number }
type Action = "deny" | "restore" | "add" | "edit";

export default function AdminLoanwordsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [addInput, setAddInput] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [wordQuery, setWordQuery] = useState("");
  const [seedQuery, setSeedQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/loanwords");
      if (!r.ok) throw new Error(String(r.status));
      setData(await r.json());
    } catch (e) { toast.error("โหลดไม่สำเร็จ: " + (e instanceof Error ? e.message : e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(action: Action, word: string, newWord?: string) {
    setBusy(word);
    try {
      const r = await fetch("/api/admin/loanwords", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, word, newWord }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || String(r.status));
      toast.success("บันทึกแล้ว");
      setEditing(null);
      await load();
    } catch (e) { toast.error("ไม่สำเร็จ: " + (e instanceof Error ? e.message : e)); }
    finally { setBusy(null); }
  }

  if (loading) return <div className="p-6 text-sm text-zinc-400">กำลังโหลด…</div>;
  if (!data) return <div className="p-6 text-sm text-red-400">โหลดข้อมูลไม่ได้</div>;

  const lastSet = new Set(data.lastAdded);
  const denySet = new Set(data.denylist);
  // newest-first (store appends, so reverse), filtered by the search box
  const shownWords = (wordQuery ? data.words.filter((w) => w.includes(wordQuery)) : data.words).slice().reverse();
  // seed words that aren't currently denied; show ALL so admins can audit every word
  const seedActive = data.seed.filter((w) => !denySet.has(w));
  const seedShown = seedQuery ? seedActive.filter((w) => w.includes(seedQuery)) : seedActive;

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      <div className="flex items-center gap-2">
        <Languages className="h-5 w-5 text-violet-400" />
        <h1 className="text-xl font-semibold text-white">จัดการคำตัดซับ (Loanwords)</h1>
      </div>
      <p className="text-sm text-zinc-400">คำที่ระบบกันไว้ไม่ให้ Intl.Segmenter หั่นกลางคำ. ถอน = ย้ายไป denylist (cron จะไม่เพิ่มกลับ) · แก้ = เปลี่ยนสะกด · เพิ่มเอง = ใส่คำเข้าระบบตรงๆ</p>

      {/* ── auto-mined + manual words ─────────────────────────────── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
        <div className="text-sm font-semibold text-white">คำที่ระบบเพิ่ม (อัตโนมัติ + เพิ่มเอง) — {data.words.length} คำ</div>
        <div className="flex gap-2">
          <input value={addInput} onChange={(e) => setAddInput(e.target.value)}
            placeholder="พิมพ์คำยืมที่อยากเพิ่ม เช่น คอนเทนต์"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-violet-500/50" />
          <button disabled={!addInput.trim() || busy === addInput.trim()}
            onClick={() => { const w = addInput.trim(); setAddInput(""); void act("add", w); }}
            className="flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-2 text-sm text-white disabled:opacity-40">
            <Plus className="h-4 w-4" /> เพิ่ม
          </button>
        </div>
        {data.words.length > 0 && (
          <input value={wordQuery} onChange={(e) => setWordQuery(e.target.value)} placeholder="ค้นหาคำในลิสต์นี้…"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-violet-500/50" />
        )}
        {data.words.length === 0
          ? <p className="text-xs text-zinc-500">ยังไม่มีคำที่ระบบเพิ่ม (cron ยังไม่เจอ/ยังไม่เพิ่มเอง)</p>
          : shownWords.length === 0
          ? <p className="text-xs text-zinc-500">ไม่พบ &quot;{wordQuery}&quot; — เรียงใหม่สุดขึ้นก่อน, badge &quot;ใหม่&quot; = เพิ่มรอบล่าสุด</p>
          : <ul className="flex flex-wrap gap-2">
              {shownWords.map((w) => (
                <li key={w} className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-sm text-white ${lastSet.has(w) ? "border-violet-500/50 bg-violet-500/10" : "border-zinc-700 bg-zinc-800"}`}>
                  {editing === w ? (
                    <>
                      <input value={editVal} onChange={(e) => setEditVal(e.target.value)} autoFocus
                        className="w-28 rounded border border-zinc-600 bg-zinc-900 px-1 text-sm text-white outline-none" />
                      <button disabled={busy === w} onClick={() => act("edit", w, editVal.trim())} className="text-green-400 disabled:opacity-40"><Check className="h-4 w-4" /></button>
                      <button onClick={() => setEditing(null)} className="text-zinc-400"><X className="h-4 w-4" /></button>
                    </>
                  ) : (
                    <>
                      <span className="font-mono">{w}</span>
                      {lastSet.has(w) && <span className="rounded bg-violet-500/30 px-1 text-[10px] text-violet-200">ใหม่</span>}
                      <button onClick={() => { setEditing(w); setEditVal(w); }} className="text-zinc-400 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
                      <button disabled={busy === w} onClick={() => act("deny", w)} className="text-red-400 hover:text-red-300 disabled:opacity-40">
                        {busy === w ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>}
      </section>

      {/* ── denylist ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
        <div className="text-sm font-semibold text-white">Denylist (คำที่ห้ามกัน) — {data.denylist.length} คำ</div>
        {data.denylist.length === 0
          ? <p className="text-xs text-zinc-500">ว่าง</p>
          : <ul className="flex flex-wrap gap-2">
              {data.denylist.map((w) => (
                <li key={w} className="flex items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-1 text-sm text-red-200">
                  <span className="font-mono">{w}</span>
                  <button disabled={busy === w} onClick={() => act("restore", w)} title="คืนค่า (เอาออกจาก denylist)" className="text-zinc-300 hover:text-white disabled:opacity-40">
                    {busy === w ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  </button>
                </li>
              ))}
            </ul>}
      </section>

      {/* ── seed (in-code, show all, deny-able via denylist override) ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <div className="text-sm font-semibold text-white">Seed ในโค้ด — {seedActive.length} คำ <span className="text-xs font-normal text-zinc-500">(ถอนได้ → override ผ่าน denylist · เพิ่มถาวรต้องผ่านโค้ด)</span></div>
        <input value={seedQuery} onChange={(e) => setSeedQuery(e.target.value)} placeholder="ค้นหาคำใน seed… (ปล่อยว่าง = เห็นทั้งหมด)"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-violet-500/50" />
        <ul className="flex flex-wrap gap-2">
          {seedShown.length === 0
            ? <li className="text-xs text-zinc-500">{seedQuery ? `ไม่พบ "${seedQuery}"` : "ว่าง"}</li>
            : seedShown.map((w) => (
                <li key={w} className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2 py-1 text-sm text-zinc-300">
                  <span className="font-mono">{w}</span>
                  <button disabled={busy === w} onClick={() => act("deny", w)} title="ถอน (override ผ่าน denylist)" className="text-red-400/70 hover:text-red-300 disabled:opacity-40">
                    {busy === w ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </li>
              ))}
        </ul>
      </section>
    </div>
  );
}
