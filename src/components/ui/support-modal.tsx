"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { X, HelpCircle, Loader2, ImagePlus, CheckCircle2, Trash2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface SupportModalProps {
  open: boolean;
  onClose: () => void;
}

export function SupportModal({ open, onClose }: SupportModalProps) {
  const { data: session } = useSession();
  const [message, setMessage] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const user = session?.user as { name?: string; email?: string; id?: string } | undefined;

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
        }, 2000);
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

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-start md:justify-start pointer-events-none">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 pointer-events-auto" onClick={onClose} />

      {/* Panel — anchored bottom-left */}
      <div
        className="relative pointer-events-auto m-3 md:m-4 md:ml-16 w-full max-w-sm rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-btn-border)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--ui-divider)" }}>
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>แจ้งปัญหา / Support</span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 transition-colors hover:bg-white/5">
            <X className="h-4 w-4" style={{ color: "var(--ui-text-muted)" }} />
          </button>
        </div>

        {/* User info strip */}
        <div className="px-4 py-2.5 flex items-center gap-2.5" style={{ background: "var(--ui-sidebar-bg)", borderBottom: "1px solid var(--ui-divider)" }}>
          <div className="h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
            style={{ background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(190 100% 40%))" }}>
            {user?.name?.slice(0, 2).toUpperCase() ?? "U"}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate" style={{ color: "var(--ui-text-primary)" }}>{user?.name ?? "User"}</p>
            <p className="text-[10px] truncate" style={{ color: "var(--ui-text-muted)" }}>{user?.email ?? ""}</p>
          </div>
          {user?.id && (
            <span className="ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
              style={{ background: "var(--ui-input-bg)", color: "var(--ui-text-muted)", border: "1px solid var(--ui-divider)" }}>
              {user.id.slice(0, 8)}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {sent ? (
            <div className="flex flex-col items-center gap-2 py-6">
              <CheckCircle2 className="h-10 w-10 text-green-400" />
              <p className="text-sm font-semibold text-green-400">ส่งคำร้องสำเร็จ!</p>
              <p className="text-xs text-center" style={{ color: "var(--ui-text-muted)" }}>ทีมงานจะติดต่อกลับทาง Email โดยเร็ว</p>
            </div>
          ) : (
            <>
              <Textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="อธิบายปัญหาที่พบ เช่น ขั้นตอนไหน, ข้อความ error ที่เห็น..."
                rows={5}
                className="resize-none text-sm border-0 focus-visible:ring-0"
                style={{ background: "var(--ui-input-bg)", border: "1px solid var(--ui-divider)", borderRadius: "0.75rem", color: "var(--ui-text-primary)" }}
              />

              {/* Image attach */}
              {imagePreview ? (
                <div className="relative rounded-xl overflow-hidden group" style={{ border: "1px solid var(--ui-divider)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imagePreview} alt="attachment" className="w-full max-h-36 object-cover" />
                  <button
                    onClick={removeImage}
                    className="absolute top-1.5 right-1.5 h-6 w-6 rounded-full flex items-center justify-center bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <p className="px-2 py-1 text-[10px] truncate" style={{ color: "var(--ui-text-muted)" }}>{image?.name}</p>
                </div>
              ) : (
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 w-full rounded-xl px-3 py-2.5 text-xs transition-colors hover:bg-white/5"
                  style={{ border: "1px dashed var(--ui-divider)", color: "var(--ui-text-muted)" }}>
                  <ImagePlus className="h-3.5 w-3.5" />
                  แนบรูปภาพ (ไม่เกิน 5 MB)
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={e => handleImage(e.target.files?.[0] ?? null)} />

              <button
                disabled={!message.trim() || sending}
                onClick={handleSend}
                className="w-full rounded-xl py-2.5 text-sm font-bold text-white transition-all disabled:opacity-40"
                style={{ background: "linear-gradient(135deg, hsl(252 83% 55%), hsl(190 100% 45%))" }}>
                {sending ? (
                  <span className="flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />กำลังส่ง...</span>
                ) : "ส่งคำร้อง"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
