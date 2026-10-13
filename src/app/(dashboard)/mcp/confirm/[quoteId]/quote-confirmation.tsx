"use client";

import { useState } from "react";
import type { VideoQuoteView, QuoteSource } from "@/lib/mcp/video-quote";
import type { PrepareVideoJobInput } from "@/lib/mcp/create-video-input";
import type { QuoteExecution } from "@/lib/mcp/video-quote.server";
import { Button } from "@/components/ui/button";

const SOURCES: Record<QuoteSource, string> = { stock: "สต็อก", "hero-ai-image": "Hero AI Image", automix: "AutoMix · สต็อกผสมภาพ AI", external: "นำเข้าสื่อจากเครื่องมือของคุณ" };
const STATES: Record<string, string> = { draft: "รอการยืนยัน", approved: "ยืนยันวงเงินแล้ว", rejected: "ปฏิเสธแล้ว", expired: "ใบยืนยันหมดอายุ", consumed: "เริ่มงานแล้ว" };

export function QuoteConfirmation({ quote: initial, input, execution }: { quote: VideoQuoteView; input: PrepareVideoJobInput; execution: QuoteExecution }) {
  const [quote, setQuote] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actionable = (quote.status === "draft" || quote.status === "approved");
  async function decide(action: "approve" | "reject") {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/mcp-quotes/${encodeURIComponent(quote.quoteId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const result = await response.json();
      if (!response.ok) { setError(`${result.message ?? "ยืนยันไม่สำเร็จ"} · ${result.next ?? "เปิดหน้านี้ใหม่"}`); return; }
      setQuote(result);
    } catch { setError("เชื่อมต่อไม่สำเร็จ กรุณาเปิดหน้านี้ใหม่เพื่อตรวจสถานะก่อนลองอีกครั้ง"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
    <p className="text-sm font-medium text-violet-400">HERO STUDIO · ยืนยันงานจาก AI ของคุณ</p>
    <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">ตรวจงานและวงเงินก่อนเริ่ม</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">ยืนยันเฉพาะงานนี้ ระบบจะตรวจสิทธิ์และยอดพร้อมใช้อีกครั้งก่อนเริ่ม หากต้องใช้เกินวงเงินจะหยุดและขอให้ยืนยันใหม่</p>
    <section aria-labelledby="work-title" className="mt-8 border-y border-border py-6">
      <h2 id="work-title" className="text-lg font-semibold">{input.title || "วิดีโอของคุณ"}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{SOURCES[quote.source]} · {quote.exactDuration ? "ความยาวจริง" : "ความยาวประมาณ"} {Math.ceil(quote.durationSeconds)} วินาที</p>
      {input.script && <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">ตรวจสคริปต์ที่อนุมัติ</summary><p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{input.script}</p></details>}
      {execution.presenterImportId && <p className="mt-3 text-sm">ใช้คลิปพิธีกรที่คุณนำเข้าสำเร็จแล้ว · ใช้เสียงในคลิป</p>}
      <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">รายละเอียดเสียง พิธีกร และรูปแบบงาน</summary><dl className="mt-3 space-y-2 text-muted-foreground">
        <div><dt className="inline">เสียง: </dt><dd className="inline">{execution.presenterImportId ? "จากคลิปพิธีกร" : `${String(execution.jobInput.voiceProvider)} · ${String(execution.jobInput.voiceProvider === "elevenlabs" ? execution.jobInput.voiceId || "ยังไม่ได้เลือกเสียง" : execution.jobInput.geminiVoiceName)}`}</dd></div>
        <div><dt className="inline">พิธีกร AI: </dt><dd className="inline">{execution.jobInput.avatarId ? `${String(execution.jobInput.avatarId)} · ${String(execution.jobInput.avatarMode)}` : "ไม่ใช้"}</dd></div>
        <div><dt className="inline">เพลง: </dt><dd className="inline break-words">{String(execution.jobInput.bgmFile || "ไม่ใช้")}</dd></div>
        <div><dt className="inline">ส่งออก: </dt><dd className="inline">{execution.exportMode === "hold" ? "พักตัวอย่างไว้ให้ตรวจและแก้ไขก่อน" : "ส่งออกเมื่อสร้างเสร็จ"}</dd></div>
      </dl></details>
    </section>
    <section aria-labelledby="cost-title" className="py-6">
      <h2 id="cost-title" className="text-lg font-semibold">วงเงินสูงสุดของงานนี้</h2>
      <dl className="mt-5 space-y-4 text-sm">
        <div className="flex justify-between gap-4"><dt>ภาพ AI สูงสุด {quote.imageCountCeiling} ภาพ{!quote.trialImageAllowance && ` × ${quote.pricing.perImageCredits} เครดิต`}</dt><dd className="shrink-0 tabular-nums">{quote.imageCreditCeiling} เครดิต</dd></div>
        {quote.trialImageAllowance && <div className="text-muted-foreground">ใช้สิทธิ์ทดลองภาพ {quote.imageCountCeiling} ภาพ · เหลือ {quote.trialImageAllowance.remaining} จาก {quote.trialImageAllowance.limit} ภาพ แยกจาก Hero credits</div>}
        <div className="flex justify-between gap-4"><dt>เรนเดอร์ · นาทีในแพ็กเกจ</dt><dd className="shrink-0 tabular-nums">{quote.includedRenderMinutes} นาที</dd></div>
        <div className="flex justify-between gap-4"><dt>เรนเดอร์ส่วนเกิน {quote.renderMinutesCeiling - quote.includedRenderMinutes} นาที × {quote.pricing.minuteCreditRate} เครดิต</dt><dd className="shrink-0 tabular-nums">{quote.renderCreditCeiling} เครดิต</dd></div>
        <div className="flex justify-between gap-4 border-t border-border pt-5 text-base font-semibold"><dt>รวมไม่เกิน</dt><dd className="shrink-0 tabular-nums">{quote.totalHeroCreditCeiling} Hero credits</dd></div>
      </dl>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">พร้อมใช้ ณ ตอนประเมิน {quote.availableCredits} เครดิต · กันไว้กับงานอื่น {quote.reservedCredits} เครดิต · หากใช้เต็มวงเงินจะเหลือ {Math.max(0, quote.projectedRemainingCredits)} เครดิต</p>
      {quote.projectedRemainingCredits < 0 && <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">เครดิตยังไม่พอ ขาด {-quote.projectedRemainingCredits} เครดิต — เติมเครดิตหรือลดงานก่อนเริ่ม</p>}
      {quote.source === "automix" && <p className="mt-3 text-sm text-muted-foreground">อนุมัติส่วนผสมสต็อกและภาพ AI ตามวงเงินนี้ ไม่เพิ่มภาพ AI แบบเสียเครดิตเอง</p>}
      {quote.externalCharges.map((line) => <p key={line} className="mt-3 text-sm leading-relaxed text-muted-foreground">{line}</p>)}
    </section>
    <section className="border-t border-border pt-6">
      <p role="status" className="font-medium">{STATES[quote.status] ?? quote.status}</p>
      <p className="mt-2 text-xs text-muted-foreground">ใช้ใบยืนยันนี้ก่อน {new Date(quote.expiresAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} (เวลาไทย) · การยืนยันยังไม่หักหรือกันเครดิต</p>
      {error && <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {actionable && <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
        {quote.status === "draft" && <Button disabled={busy} className="h-auto min-h-11 whitespace-normal bg-violet-600 px-5 py-3 text-white hover:bg-violet-700" onClick={() => decide("approve")}>{busy ? "กำลังบันทึก…" : `ยืนยันวงเงินไม่เกิน ${quote.totalHeroCreditCeiling} Hero credits`}</Button>}
        <Button disabled={busy} variant="outline" className="min-h-11" onClick={() => decide("reject")}>ปฏิเสธงานนี้</Button>
      </div>}
      {quote.status === "approved" && <p className="mt-4 text-sm text-muted-foreground">กลับไปบอก AI ของคุณว่ายืนยันแล้ว เพื่อให้เริ่มงานนี้</p>}
      {(quote.status === "expired" || quote.status === "rejected") && <p className="mt-4 text-sm text-muted-foreground">กลับไปให้ AI ของคุณจัดทำใบยืนยันใหม่หากต้องการทำงานต่อ</p>}
    </section>
  </main>;
}
