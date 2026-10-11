"use client";

import { Check, Music2, RotateCcw, VolumeX } from "lucide-react";
import {
  backgroundMusicTrackFilename,
  backgroundMusicTrackPath,
} from "@/lib/background-music";
import { useBgm } from "../_hooks/useBgm";
import { color, radius } from "./tokens";
import { GroupLabel, Toggle } from "./ui";
import type { PostPhaseEditor } from "./usePostPhaseEditor";

/**
 * EP5 U7 (HERO-71): change the music after the render — pick a library track (or none), set its
 * volume 0-100 % and duck it under the voice. Heard straight away in the preview
 * (useBackgroundMusicPreview); the file changes when the creator exports, with no new render.
 */

type Row = { key: string; title: string; track: string | null; kind: "system" | "user" | "none" };

export function BackgroundMusicControls({
  editor,
}: {
  editor: Pick<PostPhaseEditor, "backgroundMusic" | "setBackgroundMusic" | "resetBackgroundMusic">;
}) {
  const bgm = useBgm();
  const { value, changed, baseHasMusic, available } = editor.backgroundMusic;

  const rows: Row[] = [{ key: "none", title: "ไม่ใส่เพลง", track: null, kind: "none" }];
  for (const t of bgm.systemTracks) {
    const track = backgroundMusicTrackPath(t.filename, "system");
    if (track) rows.push({ key: `s:${t.id}`, title: t.title, track, kind: "system" });
  }
  for (const t of bgm.userTracks) {
    const track = backgroundMusicTrackPath(t.filename, "user");
    if (track) rows.push({ key: `u:${t.id}`, title: t.title, track, kind: "user" });
  }

  const currentFilename = backgroundMusicTrackFilename(value.track)?.filename;
  const currentTitle = value.track === null
    ? (!changed && baseHasMusic ? "เพลงเดิมของคลิป" : "ไม่ใส่เพลง")
    : [...bgm.systemTracks, ...bgm.userTracks].find((t) => t.filename === currentFilename)?.title
      ?? currentFilename
      ?? "เพลงเดิมของคลิป";
  const volumePct = Math.round(value.volume * 100);
  const hasTrack = value.track !== null;

  if (!available) {
    return (
      <div className="flex flex-col gap-2">
        <GroupLabel>เพลงประกอบ</GroupLabel>
        <span style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.6 }}>
          คลิปนี้เปลี่ยนเพลงไม่ได้ เพราะไม่พบไฟล์เสียงพากย์แยก — ส่งออกด้วยเพลงเดิมได้ตามปกติ
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-background-music-controls="true">
      <div className="flex flex-col gap-1.5">
        <GroupLabel>เพลงประกอบ</GroupLabel>
        <div className="flex items-center gap-2" style={{ fontSize: 13, color: color.text }}>
          <Music2 size={14} color={color.trackMusic} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{currentTitle}</span>
          {changed && (
            <button
              type="button"
              onClick={editor.resetBackgroundMusic}
              className="flex items-center gap-1"
              style={{ background: "none", border: "none", color: color.link, cursor: "pointer", fontSize: 11.5, padding: 0 }}
            >
              <RotateCcw size={12} aria-hidden="true" /> ใช้เพลงเดิมของคลิป
            </button>
          )}
        </div>
        <span style={{ fontSize: 10.5, color: color.textFaintest, lineHeight: 1.6 }}>
          {changed
            ? "กดเล่นเพื่อฟังได้ทันที — ไฟล์จะเปลี่ยนตอนกดส่งออก ไม่ต้องเรนเดอร์ใหม่"
            : "เพลงที่อยู่ในคลิปตอนนี้ — เลือกเพลงใหม่หรือปรับความดังได้เลย"}
        </span>
      </div>

      <div
        role="listbox"
        aria-label="เลือกเพลงประกอบ"
        className="flex flex-col gap-1 overflow-y-auto"
        style={{ maxHeight: 220, padding: 2 }}
      >
        {rows.map((row) => {
          // Unchanged + an unrecognised base path: nothing in the list is what the clip plays.
          const selected = value.track === row.track && !(row.track === null && !changed && baseHasMusic);
          return (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => editor.setBackgroundMusic({ track: row.track })}
              className="flex items-center gap-2 text-left"
              style={{
                padding: "7px 10px",
                borderRadius: radius.control,
                background: selected ? color.selectedBg : "none",
                border: `1px solid ${selected ? color.selectedBorder : "transparent"}`,
                color: color.textSecondary,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              {row.kind === "none"
                ? <VolumeX size={13} aria-hidden="true" />
                : <Music2 size={13} aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              {row.kind === "user" && <span style={{ fontSize: 10, color: color.textFaint }}>ของฉัน</span>}
              {selected && <Check size={13} color={color.primary300} aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      <label className="flex flex-col gap-2">
        <span style={{ fontSize: 11, color: color.textFaint }}>ความดังเพลง</span>
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={volumePct}
            disabled={!hasTrack}
            aria-label="ความดังเพลง"
            onChange={(e) => editor.setBackgroundMusic({ volume: Number(e.target.value) / 100 })}
            className="min-w-0 flex-1"
            style={{ accentColor: color.primary500, cursor: hasTrack ? "pointer" : "not-allowed", opacity: hasTrack ? 1 : 0.5 }}
          />
          <span style={{ fontSize: 11.5, color: color.textSecondary, fontVariantNumeric: "tabular-nums", width: 38, textAlign: "right" }}>
            {volumePct}%
          </span>
        </div>
        {!hasTrack && (
          <span style={{ fontSize: 10.5, color: color.textFaintest }}>เลือกเพลงก่อนถึงจะปรับความดังได้</span>
        )}
      </label>

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span style={{ fontSize: 12.5, color: hasTrack ? color.text : color.textFaint }}>ลดเสียงเพลงตอนพูด</span>
          <span style={{ fontSize: 10.5, color: color.textFaintest, lineHeight: 1.5 }}>
            เพลงเบาลงเองตอนมีเสียงพูด แล้วกลับมาดังช่วงเงียบ
          </span>
        </div>
        <Toggle
          on={hasTrack && value.ducking}
          onChange={(on) => { if (hasTrack) editor.setBackgroundMusic({ ducking: on }); }}
          ariaLabel="ลดเสียงเพลงตอนพูด"
        />
      </div>
    </div>
  );
}
