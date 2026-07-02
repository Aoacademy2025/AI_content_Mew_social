"use client";

import { useEffect, useRef, useState } from "react";
import { fetchMe } from "@/lib/use-me";
import { DEFAULT_AUTO_MIX_PROVIDERS, type AutoMixImageProvider, type KieImageModel } from "../_components/types";

const DRAFT_KEY = "editor-v2-project";

interface V2Draft {
  mode?: V2Mode; script?: string; brollSource?: V2BrollSource;
  voiceEngine?: V2VoiceEngine; geminiVoiceName?: string; voiceId?: string;
  musicTrack?: string | null; useAvatar?: boolean; avatarId?: string;
  targetClipCount?: number; avatarMode?: V2AvatarMode; avatarIntroSecs?: number; avatarTailSecs?: number;
  kieModel?: string; autoMixProviders?: AutoMixImageProvider[];
}

function loadDraft(): V2Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as V2Draft) : {};
  } catch { return {}; }
}

/**
 * Editor v2 project state (เฟสตั้งค่า สเต็ป 1–2) — ตาม state model ในแผน:
 * project: { script, mode, brollSource, voiceEngine, voiceId, musicTrack, avatarId|null }
 *
 * P3 = state + read-only wiring (โหลดค่า default จริงจาก /api/user/video-settings,
 * โควตาจาก /api/videos/usage, ข้อมูลอวตารจาก /api/heygen/avatar-info).
 * การเรนเดอร์จริง + persist draft มาใน P4 (VideoJob preview mode).
 */

export type V2Mode = "script" | "upload";
export type V2BrollSource = "automix" | "stock" | "kie-image" | "kie-video";
export type V2VoiceEngine = "gemini" | "elevenlabs";
export type V2AvatarMode = "bookend" | "bookend-both" | "full";

export interface V2Usage {
  plan?: string;
  minutes?: { used: number; limit: number; remaining: number };
}

export interface V2AvatarInfo {
  name?: string;
  previewUrl?: string;
}

export function useV2Project() {
  // Restore draft ก่อน (จำการตั้งค่าโปรเจกต์ข้ามเซสชัน) — ค่า default จาก server
  // จะไม่ทับของที่ผู้ใช้ตั้งไว้แล้ว (ดู effect ด้านล่าง)
  const draftRef = useRef<V2Draft>(typeof window === "undefined" ? {} : loadDraft());
  const d = draftRef.current;

  // ── Step 1 ──
  const [mode, setMode] = useState<V2Mode>(d.mode ?? "script");
  const [script, setScript] = useState(d.script ?? "");

  // ── Step 2 ──
  // default = วิดีโอสต็อก (ฟรี) — AutoMix/ภาพ AI ยัง Beta (admin เท่านั้น), วิดีโอ AI ยังไม่เปิด
  const [brollSource, setBrollSource] = useState<V2BrollSource>(d.brollSource ?? "stock");
  const [isAdmin, setIsAdmin] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState<V2VoiceEngine>(d.voiceEngine ?? "gemini");
  const [geminiVoiceName, setGeminiVoiceName] = useState(d.geminiVoiceName ?? "Aoede");
  const [voiceId, setVoiceId] = useState(d.voiceId ?? "");
  /** filename ของ system track ที่เลือก · "" = ยังไม่เลือก · null = ไม่ใส่เพลง */
  const [musicTrack, setMusicTrack] = useState<string | null>(d.musicTrack === undefined ? "" : d.musicTrack);
  const [useAvatar, setUseAvatar] = useState(d.useAvatar ?? false);
  const [avatarId, setAvatarId] = useState(d.avatarId ?? "");

  // ── ขั้นสูง (P6c) ──
  const [targetClipCount, setTargetClipCount] = useState(d.targetClipCount ?? 0); // 0 = auto
  const [avatarMode, setAvatarMode] = useState<V2AvatarMode>(d.avatarMode ?? "bookend");
  const [avatarIntroSecs, setAvatarIntroSecs] = useState(d.avatarIntroSecs ?? 5);
  const [avatarTailSecs, setAvatarTailSecs] = useState(d.avatarTailSecs ?? 5);
  const [kieModel, setKieModel] = useState<KieImageModel | "">((d.kieModel as KieImageModel | undefined) ?? "");
  const [autoMixProviders, setAutoMixProviders] = useState<AutoMixImageProvider[]>(d.autoMixProviders ?? DEFAULT_AUTO_MIX_PROVIDERS);

  // ── Read-only wiring ──
  const [usage, setUsage] = useState<V2Usage | null>(null);
  const [avatarInfo, setAvatarInfo] = useState<V2AvatarInfo | null>(null);

  // ค่า default จริงของผู้ใช้ (เหมือน init ของ legacy editor) — ไม่ทับค่าที่ draft จำไว้
  useEffect(() => {
    const hadDraft = Object.keys(draftRef.current).length > 0;
    fetch("/api/user/video-settings").then(r => r.json()).then(s => {
      if (!hadDraft) {
        if (s.heygenAvatarId) setAvatarId(s.heygenAvatarId);
        if (s.elevenlabsVoiceId) setVoiceId(s.elevenlabsVoiceId);
        if (s.ttsProvider === "gemini" || s.ttsProvider === "elevenlabs") setVoiceEngine(s.ttsProvider);
        if (s.geminiVoiceName) setGeminiVoiceName(s.geminiVoiceName);
      } else {
        // เติมเฉพาะช่องที่ draft ไม่มีค่า
        if (s.heygenAvatarId && !draftRef.current.avatarId) setAvatarId(s.heygenAvatarId);
        if (s.elevenlabsVoiceId && !draftRef.current.voiceId) setVoiceId(s.elevenlabsVoiceId);
      }
    }).catch(() => {});
    fetch("/api/videos/usage").then(r => (r.ok ? r.json() : null)).then(u => {
      if (u) setUsage(u);
    }).catch(() => {});
    fetchMe().then(m => setIsAdmin(m?.role === "ADMIN")).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist draft (debounce 1s) — จำการตั้งค่าโปรเจกต์ข้ามเซสชัน
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          mode, script, brollSource, voiceEngine, geminiVoiceName, voiceId,
          musicTrack, useAvatar, avatarId,
          targetClipCount, avatarMode, avatarIntroSecs, avatarTailSecs,
          kieModel, autoMixProviders,
        } satisfies V2Draft));
      } catch { /* quota/private mode */ }
    }, 1000);
    return () => clearTimeout(t);
  }, [mode, script, brollSource, voiceEngine, geminiVoiceName, voiceId, musicTrack, useAvatar, avatarId,
      targetClipCount, avatarMode, avatarIntroSecs, avatarTailSecs, kieModel, autoMixProviders]);

  // ข้อมูลอวตาร (ชื่อ + thumbnail) เมื่อมี avatarId
  useEffect(() => {
    if (!avatarId.trim()) { setAvatarInfo(null); return; }
    let alive = true;
    fetch(`/api/heygen/avatar-info?avatarId=${encodeURIComponent(avatarId.trim())}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setAvatarInfo({ name: d.name, previewUrl: d.previewUrl ?? d.thumbnailUrl }); })
      .catch(() => { if (alive) setAvatarInfo(null); });
    return () => { alive = false; };
  }, [avatarId]);

  return {
    mode, setMode,
    script, setScript,
    brollSource, setBrollSource,
    voiceEngine, setVoiceEngine,
    geminiVoiceName, setGeminiVoiceName,
    voiceId, setVoiceId,
    musicTrack, setMusicTrack,
    useAvatar, setUseAvatar,
    avatarId, setAvatarId,
    targetClipCount, setTargetClipCount,
    avatarMode, setAvatarMode,
    avatarIntroSecs, setAvatarIntroSecs,
    avatarTailSecs, setAvatarTailSecs,
    kieModel, setKieModel,
    autoMixProviders, setAutoMixProviders,
    usage, avatarInfo, isAdmin,
  };
}

export type V2Project = ReturnType<typeof useV2Project>;
