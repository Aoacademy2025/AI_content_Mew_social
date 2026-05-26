"use client";

import { useEffect, useRef, useState } from "react";
import { X, HelpCircle, Loader2, ImagePlus, CheckCircle2, Trash2, Sparkles, Crown, Building2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface SupportModalProps {
  open: boolean;
  onClose: () => void;
}

const MAX_LEN = 1000;

export function SupportModal({ open, onClose }: SupportModalProps) {
  const [message, setMessage] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [plan, setPlan] = useState("FREE");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      fetch("/api/user/me").then(r => r.json()).then(d => { if (d.plan) setPlan(d.plan); }).catch(() => {});
    }
  }, [open]);

  const isBusiness = plan === "BUSINESS";
  const isPro = plan === "PRO";
  const isPaid = isPro || isBusiness;

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function handleImage(file: File | null) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("รูปภาพต้องไม่เกิน 5 MB"); return; }
    setImage(file);
    const reader = new FileReader();
    reader.onload = e => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  function removeImage() {
    setImage(null);
    setImagePreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleSend() {
    if (!message.trim()) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append("message", message.trim());
      if (image) fd.append("image", image);

      const res = await fetch("/api/support", { method: "POST", body: fd });
      if (res.ok) {
        setSent(true);
        setTimeout(() => {
          setSent(false);
          setMessage("");
          removeImage();
          onClose();
        }, 2200);
      } else {
        const d = await res.json();
        toast.error(d.error ?? "ส่งไม่สำเร็จ");
      }
    } catch {
      toast.error("ส่งไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  const PlanIcon = isBusiness ? Building2 : isPro ? Crown : null;
  const planLabel = isBusiness ? "Business" : isPro ? "Pro" : "Free";
  const planColor = isBusiness
    ? "from-violet-500/30 to-fuchsia-500/30 text-violet-200 border-violet-400/40"
    : isPro
    ? "from-yellow-500/20 to-amber-500/20 text-yellow-300 border-yellow-400/40"
    : "from-zinc-500/15 to-zinc-500/15 text-zinc-400 border-zinc-500/30";

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* Light backdrop — click to close, does not block content visually */}
      <div
        className="fixed inset-0 pointer-events-auto"
        style={{ background: "rgba(8, 8, 16, 0.35)", animation: "support-fade-in 200ms ease-out" }}
        onClick={onClose}
      />

      {/* Right-side panel */}
      <div
        className="fixed top-0 right-0 bottom-0 w-full max-w-md pointer-events-auto flex flex-col"
        style={{
          background: "linear-gradient(180deg, rgba(20, 20, 32, 0.99), rgba(14, 14, 22, 0.99))",
          borderLeft: "1px solid rgba(124, 58, 237, 0.25)",
          boxShadow: "-20px 0 60px -15px rgba(0, 0, 0, 0.6)",
          animation: "support-slide-in 320ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* Inner content wrapper — same visual styling as before */}
        <div className="relative flex flex-col h-full overflow-y-auto">
          {/* Header — gradient with icon badge */}
          <div className="relative px-5 pt-5 pb-4">
            <div
              aria-hidden
              className="absolute inset-0 opacity-40 pointer-events-none"
              style={{ background: "radial-gradient(circle at 0% 0%, hsl(252 83% 55% / 0.4), transparent 60%)" }}
            />
            <div className="relative flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-xl shrink-0"
                  style={{
                    background: "linear-gradient(135deg, hsl(252 83% 55%), hsl(190 100% 45%))",
                    boxShadow: "0 4px 16px hsl(252 83% 55% / 0.4)",
                  }}
                >
                  <HelpCircle className="h-4.5 w-4.5 text-white" />
                </div>
                <div>
                  <h2 className="text-[15px] font-bold leading-tight text-white">Support</h2>
                  <p className="text-[11px] text-zinc-400 mt-0.5">ทีมงานตอบกลับภายใน 24 ชม.</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 -mt-1 -mr-1 transition-colors hover:bg-white/10"
                aria-label="ปิด"
              >
                <X className="h-4 w-4 text-zinc-400 hover:text-white transition-colors" />
              </button>
            </div>
          </div>

          {/* User info strip */}
          <div
            className="mx-5 mb-4 flex items-center gap-3 rounded-xl px-3 py-2.5"
            style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid rgba(255, 255, 255, 0.06)" }}
          >
            <div
              className="h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
              style={{ background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(190 100% 40%))" }}
            >
              U
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold truncate text-white">ผู้ใช้งาน</p>
              <p className="text-[10px] truncate text-zinc-500">{planLabel}</p>
            </div>
            <span
              className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-linear-to-r ${planColor}`}
            >
              {PlanIcon && <PlanIcon className="h-2.5 w-2.5" />}
              {planLabel}
            </span>
          </div>

          {/* Body */}
          <div className="px-5 pb-5 space-y-3">
            {sent ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <div
                  className="h-14 w-14 rounded-full flex items-center justify-center"
                  style={{
                    background: "linear-gradient(135deg, hsl(142 76% 45% / 0.2), hsl(160 76% 45% / 0.2))",
                    boxShadow: "0 0 30px hsl(142 76% 45% / 0.3)",
                  }}
                >
                  <CheckCircle2 className="h-7 w-7 text-emerald-400" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold text-emerald-300">ส่งคำร้องสำเร็จ!</p>
                  <p className="text-xs text-zinc-400 mt-1">ทีมงานจะติดต่อกลับทาง Email</p>
                </div>
              </div>
            ) : (
              <>
                {/* Priority hint for paid users */}
                {isPaid && (
                  <div
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-[11px]"
                    style={{
                      background: "linear-gradient(90deg, rgba(124, 58, 237, 0.08), rgba(34, 211, 238, 0.05))",
                      border: "1px solid rgba(124, 58, 237, 0.2)",
                    }}
                  >
                    <Sparkles className="h-3 w-3 text-violet-300 shrink-0" />
                    <span className="text-violet-200">
                      <b className="text-white">Priority Support</b> — คำร้องของคุณจะได้รับการตอบกลับก่อน
                    </span>
                  </div>
                )}

                <div className="relative">
                  <Textarea
                    value={message}
                    onChange={e => setMessage(e.target.value.slice(0, MAX_LEN))}
                    placeholder="อธิบายปัญหาที่พบ เช่น ขั้นตอนไหน, ข้อความ error ที่เห็น..."
                    rows={5}
                    className="resize-none text-sm border-0 focus-visible:ring-2 focus-visible:ring-violet-500/40 transition-shadow rounded-xl"
                    style={{
                      background: "rgba(255, 255, 255, 0.03)",
                      border: "1px solid rgba(255, 255, 255, 0.08)",
                      color: "#fff",
                      paddingBottom: "1.75rem",
                    }}
                  />
                  <span className="absolute bottom-2 right-3 text-[10px] text-zinc-600 font-mono pointer-events-none">
                    {message.length}/{MAX_LEN}
                  </span>
                </div>

                {/* Image attach */}
                {imagePreview ? (
                  <div
                    className="relative rounded-xl overflow-hidden group"
                    style={{ border: "1px solid rgba(255, 255, 255, 0.08)" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imagePreview} alt="attachment" className="w-full max-h-40 object-cover" />
                    <div className="absolute inset-x-0 bottom-0 px-2.5 py-1.5 flex items-center justify-between"
                      style={{ background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.85))" }}>
                      <span className="text-[10px] text-white/80 truncate">{image?.name}</span>
                      <button
                        onClick={removeImage}
                        className="h-6 w-6 rounded-full flex items-center justify-center bg-white/10 hover:bg-red-500/40 text-white transition-colors"
                        aria-label="ลบรูป"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center justify-center gap-2 w-full rounded-xl px-3 py-2.5 text-xs transition-all hover:bg-white/4 hover:border-violet-400/30"
                    style={{ border: "1px dashed rgba(255, 255, 255, 0.12)", color: "rgba(255, 255, 255, 0.5)" }}
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    แนบภาพหน้าจอ (สูงสุด 5 MB)
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => handleImage(e.target.files?.[0] ?? null)}
                />

                <button
                  disabled={!message.trim() || sending}
                  onClick={handleSend}
                  className="relative w-full rounded-xl py-3 text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed group overflow-hidden"
                  style={{
                    background: "linear-gradient(135deg, hsl(252 83% 55%), hsl(190 100% 45%))",
                    boxShadow: message.trim() && !sending
                      ? "0 8px 24px hsl(252 83% 55% / 0.35), 0 0 0 1px rgba(255, 255, 255, 0.1) inset"
                      : "none",
                  }}
                >
                  <span
                    aria-hidden
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ background: "linear-gradient(135deg, hsl(252 83% 60%), hsl(190 100% 50%))" }}
                  />
                  <span className="relative flex items-center justify-center gap-2">
                    {sending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        กำลังส่ง...
                      </>
                    ) : (
                      "ส่งคำร้อง"
                    )}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
        {/* /inner wrapper */}
      </div>
      {/* /right panel */}

      {/* Animation keyframes */}
      <style jsx global>{`
        @keyframes support-fade-in {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes support-slide-in {
          0%   { opacity: 0; transform: translateX(24px); }
          100% { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
