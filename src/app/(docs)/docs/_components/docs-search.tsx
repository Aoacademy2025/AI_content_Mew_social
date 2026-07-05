"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { searchIndex } from "../_content/registry";

export function DocsSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return searchIndex
      .filter((m) =>
        m.title.toLowerCase().includes(term) ||
        m.summary.toLowerCase().includes(term) ||
        m.keywords.some((k) => k.toLowerCase().includes(term)))
      .slice(0, 8);
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function go(slug: string) {
    setOpen(false);
    setQ("");
    router.push(`/docs/${slug}`);
  }

  return (
    <div ref={boxRef} className="relative w-full max-w-md">
      <div className="flex items-center gap-2 rounded-lg px-3 py-1.5"
        style={{ background: "hsl(0 0% 100% / 0.05)", border: "1px solid var(--ui-divider)" }}>
        <Search className="h-3.5 w-3.5" style={{ color: "var(--ui-text-muted)" }} />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="ค้นหาวิธีใช้งาน…"
          className="w-full bg-transparent text-[13px] outline-none"
          style={{ color: "var(--ui-text-primary)" }}
        />
      </div>
      {open && results.length > 0 && (
        <div className="premium-glass absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl">
          {results.map((m) => (
            <button key={m.slug} onClick={() => go(m.slug)}
              className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-white/5">
              <span className="text-[13px] font-semibold" style={{ color: "var(--ui-text-primary)" }}>{m.title}</span>
              <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{m.category} · {m.summary}</span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim() && results.length === 0 && (
        <div className="premium-glass absolute left-0 right-0 top-full z-50 mt-1.5 rounded-xl px-3.5 py-3 text-[12px]"
          style={{ color: "var(--ui-text-muted)" }}>
          ไม่พบหัวข้อที่ตรงกับ “{q}”
        </div>
      )}
    </div>
  );
}
