"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Flag = "wrong_identity" | "missing_text" | "severe_distortion" | "privacy_anomaly";
type Score = { pairId: string; choice: "A" | "B" | "tie"; flagsBySide: { A: Flag[]; B: Flag[] } };
type ReviewPair = { pairId: string; audio: { A: string; B: string }; score: Score | null; labels?: { A: string; B: string } };
type Review = {
  version: 1;
  state: "reviewing" | "locked" | "revealed";
  revision: number;
  complete: number;
  pairs: ReviewPair[];
  aggregates?: Record<string, number>;
};

const FLAGS: readonly { value: Flag; label: string }[] = [
  { value: "wrong_identity", label: "เสียงไม่ใช่คนเดิม" },
  { value: "missing_text", label: "ข้อความขาด" },
  { value: "severe_distortion", label: "เสียงแตกชัดเจน" },
  { value: "privacy_anomaly", label: "ความเป็นส่วนตัวผิดปกติ" },
];

function canonicalScore(choice: Score["choice"], flagsBySide: Score["flagsBySide"]): string {
  return JSON.stringify({ choice, flagsBySide: { A: [...flagsBySide.A].sort(), B: [...flagsBySide.B].sort() } });
}

export default function ReviewClient({ runId }: { runId: string }) {
  const router = useRouter();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/ai-studio/voice-clone-canary/runs/${encodeURIComponent(runId)}`;

  const refresh = useCallback(async () => {
    const response = await fetch(base, { cache: "no-store" });
    if (!response.ok) throw new Error("เปิดชุดฟังไม่ได้");
    setReview(await response.json() as Review);
  }, [base]);

  useEffect(() => { refresh().catch((cause: Error) => setError(cause.message)); }, [refresh]); // eslint-disable-line react-hooks/set-state-in-effect -- refresh only updates state after its awaited fetch resolves; this is the initial external API synchronization.

  const save = async (pair: ReviewPair, choice: Score["choice"], flagsBySide: Score["flagsBySide"]) => {
    if (!review || review.state !== "reviewing") return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${base}/scores/${encodeURIComponent(pair.pairId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": `"${review.revision}"` },
        body: canonicalScore(choice, flagsBySide),
      });
      if (!response.ok) throw new Error("บันทึกผลไม่ได้ กรุณาโหลดใหม่");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "บันทึกผลไม่ได้"); }
    finally { setBusy(false); }
  };

  const transition = async (action: "lock" | "reveal" | "close") => {
    if (!review) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${base}/${action}`, {
        method: "POST",
        headers: { "If-Match": `"${review.revision}"` },
      });
      if (!response.ok) throw new Error("ยืนยันขั้นตอนนี้ไม่ได้");
      if (action === "close") router.push("/ai-studio");
      else await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ยืนยันขั้นตอนไม่ได้"); }
    finally { setBusy(false); }
  };

  if (!review) return <main className="min-h-screen bg-[#f3efe6] p-8 text-[#152b2a]">{error || "กำลังเปิดชุดฟัง…"}</main>;

  return (
    <main className="min-h-screen bg-[#f3efe6] px-4 py-8 text-[#152b2a] sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-9 border-b border-[#152b2a]/25 pb-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-[#9b3f2f]">Private listening room</p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="font-serif text-4xl leading-tight sm:text-5xl">ฟังโดยไม่เห็นเฉลย</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[#405452]">ฟัง A และ B ให้จบ แล้วเลือกเสียงที่นำไปใช้งานได้จริงกว่า หากมีปัญหารุนแรงให้ทำเครื่องหมายไว้</p>
            </div>
            <div className="rounded-full border border-[#152b2a]/30 px-4 py-2 text-sm tabular-nums">{review.complete} / 18</div>
          </div>
        </header>

        {error && <p role="alert" className="mb-5 border-l-4 border-[#9b3f2f] bg-white/60 px-4 py-3 text-sm">{error}</p>}

        <ol className="grid gap-5">
          {review.pairs.map((pair, index) => {
            const score = pair.score ?? { pairId: pair.pairId, choice: "tie" as const, flagsBySide: { A: [], B: [] } };
            return (
              <li key={pair.pairId} className="border border-[#152b2a]/20 bg-[#fffdf8] p-5 shadow-[4px_4px_0_#d8c7ad] sm:p-6">
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="font-serif text-2xl">คู่ที่ {String(index + 1).padStart(2, "0")}</h2>
                  <span className="text-xs uppercase tracking-[0.18em] text-[#667572]">{pair.score ? "บันทึกแล้ว" : "รอฟัง"}</span>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(["A", "B"] as const).map((side) => (
                    <section key={side} className="border border-[#152b2a]/15 bg-[#f3efe6]/70 p-4">
                      <p className="mb-3 font-serif text-3xl">{side}</p>
                      {pair.labels && <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#9b3f2f]">
                        {pair.labels[side]}
                      </p>}
                      <audio className="mb-4 w-full" controls preload="none" src={`${base}/audio/${pair.audio[side]}`} />
                      <div className="grid gap-2">
                        {FLAGS.map((flag) => {
                          const selected = score.flagsBySide[side].includes(flag.value);
                          return <label key={flag.value} className="flex min-h-8 items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={busy || review.state !== "reviewing"}
                              onChange={() => {
                                const next = selected
                                  ? score.flagsBySide[side].filter((item) => item !== flag.value)
                                  : [...score.flagsBySide[side], flag.value];
                                void save(pair, score.choice, { ...score.flagsBySide, [side]: next });
                              }}
                            />
                            {flag.label}
                          </label>;
                        })}
                      </div>
                    </section>
                  ))}
                </div>
                <div className="mt-5 grid grid-cols-3 gap-2">
                  {(["A", "tie", "B"] as const).map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      disabled={busy || review.state !== "reviewing"}
                      onClick={() => void save(pair, choice, score.flagsBySide)}
                      className={`min-h-11 border px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b3f2f] disabled:opacity-50 ${score.choice === choice && pair.score ? "border-[#9b3f2f] bg-[#9b3f2f] text-white" : "border-[#152b2a]/35 bg-transparent hover:bg-[#152b2a] hover:text-white"}`}
                    >
                      {choice === "tie" ? "พอๆ กัน" : `เลือก ${choice}`}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>

        <footer className="sticky bottom-4 mt-8 flex flex-wrap items-center justify-between gap-3 border border-[#152b2a]/25 bg-[#fffdf8]/95 p-4 shadow-[4px_4px_0_#d8c7ad] backdrop-blur">
          <p className="text-sm">{review.state === "reviewing" ? "บันทึกให้ครบก่อนล็อกผล" : review.state === "locked" ? "ผลถูกล็อกแล้ว พร้อมเปิดเฉลย" : "ตรวจผลแล้ว ปิดห้องได้"}</p>
          {review.state === "reviewing" && <button className="min-h-11 bg-[#152b2a] px-5 text-sm font-semibold text-white disabled:opacity-40" disabled={busy || review.complete !== 18} onClick={() => void transition("lock")}>ล็อกผล</button>}
          {review.state === "locked" && <button className="min-h-11 bg-[#9b3f2f] px-5 text-sm font-semibold text-white disabled:opacity-40" disabled={busy} onClick={() => void transition("reveal")}>เปิดผลสรุป</button>}
          {review.state === "revealed" && <button className="min-h-11 bg-[#152b2a] px-5 text-sm font-semibold text-white disabled:opacity-40" disabled={busy} onClick={() => void transition("close")}>ปิดและลบไฟล์</button>}
        </footer>
      </div>
    </main>
  );
}
