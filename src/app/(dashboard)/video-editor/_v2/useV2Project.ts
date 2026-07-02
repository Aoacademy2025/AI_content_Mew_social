"use client";

import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/use-me";

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

export interface V2Usage {
  plan?: string;
  minutes?: { used: number; limit: number; remaining: number };
}

export interface V2AvatarInfo {
  name?: string;
  previewUrl?: string;
}

export function useV2Project() {
  // ── Step 1 ──
  const [mode, setMode] = useState<V2Mode>("script");
  const [script, setScript] = useState("");

  // ── Step 2 ──
  // default = วิดีโอสต็อก (ฟรี) — AutoMix/ภาพ AI ยัง Beta (admin เท่านั้น), วิดีโอ AI ยังไม่เปิด
  const [brollSource, setBrollSource] = useState<V2BrollSource>("stock");
  const [isAdmin, setIsAdmin] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState<V2VoiceEngine>("gemini");
  const [geminiVoiceName, setGeminiVoiceName] = useState("Aoede");
  const [voiceId, setVoiceId] = useState("");
  /** filename ของ system track ที่เลือก · "" = ยังไม่เลือก · null = ไม่ใส่เพลง */
  const [musicTrack, setMusicTrack] = useState<string | null>("");
  const [useAvatar, setUseAvatar] = useState(false);
  const [avatarId, setAvatarId] = useState("");

  // ── Read-only wiring ──
  const [usage, setUsage] = useState<V2Usage | null>(null);
  const [avatarInfo, setAvatarInfo] = useState<V2AvatarInfo | null>(null);

  // ค่า default จริงของผู้ใช้ (เหมือน init ของ legacy editor)
  useEffect(() => {
    fetch("/api/user/video-settings").then(r => r.json()).then(d => {
      if (d.heygenAvatarId) setAvatarId(d.heygenAvatarId);
      if (d.elevenlabsVoiceId) setVoiceId(d.elevenlabsVoiceId);
      if (d.ttsProvider === "gemini" || d.ttsProvider === "elevenlabs") setVoiceEngine(d.ttsProvider);
      if (d.geminiVoiceName) setGeminiVoiceName(d.geminiVoiceName);
    }).catch(() => {});
    fetch("/api/videos/usage").then(r => (r.ok ? r.json() : null)).then(d => {
      if (d) setUsage(d);
    }).catch(() => {});
    fetchMe().then(d => setIsAdmin(d?.role === "ADMIN")).catch(() => {});
  }, []);

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
    usage, avatarInfo, isAdmin,
  };
}

export type V2Project = ReturnType<typeof useV2Project>;
