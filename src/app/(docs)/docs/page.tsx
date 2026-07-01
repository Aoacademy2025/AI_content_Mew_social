"use client";

import Link from "next/link";
import { docsByCategory } from "./_content/registry";

export default function DocsHome() {
  return (
    <div className="space-y-8">
      <div>
        <p className="eyebrow mb-2">คู่มือการใช้งาน</p>
        <h1 className="text-2xl font-bold" style={{ color: "var(--ui-text-primary)", fontFamily: "'Bai Jamjuree', sans-serif" }}>
          วิธีใช้งาน Hero AI Creator Studio
        </h1>
        <p className="mt-2 text-[14px]" style={{ color: "var(--ui-text-secondary)" }}>
          เปลี่ยนสคริปต์เป็นวิดีโอสั้นอัตโนมัติ — เลือกหัวข้อด้านล่าง หรือค้นหาด้านบน
        </p>
      </div>
      {docsByCategory.map((cat) => (
        <div key={cat.name} className="space-y-2.5">
          <h2 className="text-[13px] font-bold uppercase tracking-wider" style={{ color: "var(--ui-text-muted)" }}>{cat.name}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {cat.items.map((m) => (
              <Link key={m.slug} href={`/docs/${m.slug}`} className="premium-card premium-card-interactive block p-4">
                <p className="text-[14px] font-bold" style={{ color: "var(--ui-text-primary)" }}>{m.title}</p>
                <p className="mt-1 text-[12px]" style={{ color: "var(--ui-text-muted)" }}>{m.summary}</p>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
