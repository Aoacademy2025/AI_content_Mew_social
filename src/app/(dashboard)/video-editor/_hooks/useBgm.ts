"use client";

import { useEffect, useState } from "react";

/**
 * BGM domain state — extracted verbatim from page.tsx (P1 behavior-preserving move).
 * Shared by the legacy editor and Editor v2.
 */

export interface SystemTrack { id: string; title: string; filename: string; }
export interface UserMusicTrack { id: string; title: string; filename: string; sizeBytes?: number | null; }

export function useBgm() {
  const [bgmEnabled, setBgmEnabled] = useState(false);
  const [bgmFile, setBgmFile] = useState("");
  const [bgmVolume, setBgmVolume] = useState(0.12);
  const [bgmUploading, setBgmUploading] = useState(false);

  // BGM is "on" exactly when a track is selected — the UI no longer has a separate
  // enable toggle. Deriving it here keeps every bgmEnabled consumer (render patch,
  // save config, status chip, draft) working unchanged.
  useEffect(() => { setBgmEnabled(!!bgmFile); }, [bgmFile]);

  const [systemTracks, setSystemTracks] = useState<SystemTrack[]>([]);
  const [userTracks, setUserTracks] = useState<UserMusicTrack[]>([]);

  useEffect(() => {
    fetch("/api/music").then(r => r.json()).then(d => {
      if (d.tracks) setSystemTracks(d.tracks);
      if (d.userTracks) setUserTracks(d.userTracks);
    }).catch(() => {});
  }, []);

  return {
    bgmEnabled, setBgmEnabled,
    bgmFile, setBgmFile,
    bgmVolume, setBgmVolume,
    bgmUploading, setBgmUploading,
    systemTracks,
    userTracks, setUserTracks,
  };
}
