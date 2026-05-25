"use client";

import { useRouter } from "next/navigation";
import { Crown, X, Zap } from "lucide-react";

interface UpgradeModalProps {
  open: boolean;
  message?: string;
  onClose: () => void;
}

export function UpgradeModal({ open, message, onClose }: UpgradeModalProps) {
  const router = useRouter();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-[#111118] p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Icon */}
        <div className="mb-4 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{ background: "linear-gradient(135deg, rgba(124,58,237,0.3), rgba(6,182,212,0.3))", border: "1px solid rgba(124,58,237,0.4)" }}>
            <Crown className="h-7 w-7 text-violet-400" />
          </div>
        </div>

        <h3 className="mb-2 text-center text-lg font-bold text-white">
          ฟีเจอร์นี้ใช้ได้เฉพาะแผน Pro
        </h3>

        <p className="mb-5 text-center text-sm text-zinc-400 leading-relaxed">
          {message ?? "อัปเกรดเป็น Pro เพื่อใช้งานฟีเจอร์นี้และอีกมากมาย"}
        </p>

        {/* Benefits */}
        <ul className="mb-5 space-y-2">
          {[
            "100 คลิป/เดือน ไม่จำกัดจำนวนต่อวัน",
            "Avatar, ElevenLabs TTS, Background Removal",
            "Music, Subtitle styles ทุกรูปแบบ",
            "Video Editor ขั้นสูงครบฟีเจอร์",
          ].map((f) => (
            <li key={f} className="flex items-center gap-2 text-xs text-zinc-300">
              <Zap className="h-3.5 w-3.5 shrink-0 text-violet-400" />
              {f}
            </li>
          ))}
        </ul>

        {/* Buttons */}
        <button
          onClick={() => { onClose(); router.push("/pricing"); }}
          className="w-full rounded-xl py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
          style={{ background: "linear-gradient(135deg, #7c3aed, #2563eb)" }}
        >
          ดูแผนราคา — อัปเกรดเลย
        </button>

        <button
          onClick={onClose}
          className="mt-2 w-full rounded-xl py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          ไว้ทีหลัง
        </button>
      </div>
    </div>
  );
}
