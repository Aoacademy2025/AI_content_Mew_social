"use client";

/**
 * เฟสแต่งซับ (สเต็ป 3, จอ 4b) — P6a: การ์ดซับซ้าย (แก้ข้อความได้) + preview กลางพร้อม
 * ซับสดตามสไตล์ + แผงคุมซับขวา + "ส่งออกวิดีโอ" (burn ผ่าน render path เดิม — ฟรี
 * เพราะ base render จ่ายแล้ว isBurnAlreadyPaid) · timeline 4 แทร็ก = P6b
 *
 * state/logic ทั้งหมดอยู่ใน usePostPhaseEditor (ใช้ร่วมกับ PostPhaseMobile) — ไฟล์นี้
 * เป็นเลย์เอาต์ desktop 3 คอลัมน์ (การ์ดซับ | preview | คุมซับ) + timeline ล้วน ๆ
 */

import { ArrowDownToLine, CheckCircle2, Download, Loader2, Move, Pencil } from "lucide-react";
import { color, font, radius } from "./tokens";
import { BtnPrimary, BtnSecondary, BtnGhost, Card, GroupLabel, Segmented } from "./ui";
import {
  V2_QUICK_STYLES, PRESETS_DATA, EFFECTS_DATA, FONTS_LIST,
  EDITABLE_EFFECT_PRESETS_DATA, BUILT_IN_EFFECT_PRESETS_DATA,
  V2_TEXT_COLORS, V2_ACCENT_COLORS,
  LOCKED_EFFECT_PRESETS, LOCKED_COLOR_PRESETS, LOCKED_ACCENT_PRESETS,
  V2_CARD_LEN_OPTIONS, type V2CardLen,
} from "./subtitle-style";
import type { V2JobState } from "./useV2Job";
import { TimelinePanel } from "./TimelinePanel";
import { V2CaptionOverlay } from "./V2CaptionOverlay";
import { AvatarAdjustOverlay } from "./AvatarAdjustOverlay";
import { usePostPhaseEditor } from "./usePostPhaseEditor";

function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PostPhase({ job, script, onExported, onNewProject }: {
  job: V2JobState; script: string; onExported: () => void; onNewProject: () => void;
}) {
  const ed = usePostPhaseEditor(job, script, { onExported });

  if (ed.exp.phase === "done") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={18} color={color.success} />
          <span style={{ font: `600 16px ${font.heading}`, color: color.success }}>ส่งออกสำเร็จ — อยู่ใน Gallery แล้ว</span>
        </div>
        <video src={ed.exp.url} controls playsInline className="max-h-[52vh]" style={{ borderRadius: radius.cardLg, border: `1px solid ${color.cardBorder}`, aspectRatio: "9/16" }} />
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a href={ed.exp.url} download>
            <BtnPrimary><span className="flex items-center gap-2"><Download size={14} /> ดาวน์โหลด</span></BtnPrimary>
          </a>
          <a href="/videos"><BtnSecondary>ดูใน Gallery</BtnSecondary></a>
          <BtnGhost onClick={() => ed.setExp({ phase: "idle" })}>แก้ซับต่อ &amp; ส่งออกใหม่</BtnGhost>
          <BtnGhost onClick={onNewProject}>เริ่มโปรเจกต์ใหม่</BtnGhost>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* แถบสถานะ + CTA เดียว */}
      <div className="flex shrink-0 items-center justify-between px-5 py-2.5" style={{ borderBottom: `1px solid ${color.cardBorder}` }}>
        <span className="flex items-center gap-2" style={{ fontSize: 12 }}>
          <CheckCircle2 size={14} color={color.success} />
          <span style={{ color: color.success }}>เรนเดอร์เสร็จแล้ว</span>
          <span style={{ color: color.textFaintest }}>· แก้ซับเห็นผลทันที ไม่ต้องเรนเดอร์ใหม่</span>
        </span>
        {!ed.adjustingAvatar && (
          <div className="flex items-center gap-3">
            <button onClick={onNewProject} style={{ fontSize: 12, color: color.link, background: "none", border: "none", cursor: "pointer" }}>
              เรนเดอร์ใหม่
            </button>
            <BtnPrimary
              onClick={() => void ed.exportVideo()}
              disabled={ed.exp.phase === "burning" || ed.exp.phase === "saving"}
              style={{ padding: "9px 20px", ...(ed.exp.phase === "burning" || ed.exp.phase === "saving" ? { opacity: 0.7, cursor: "wait" } : {}) }}
            >
              {ed.exp.phase === "burning" ? `กำลังฝังซับ ${ed.exp.progress}%` : ed.exp.phase === "saving" ? "กำลังบันทึก…" : "ส่งออกวิดีโอ"}
            </BtnPrimary>
          </div>
        )}
      </div>
      {ed.exp.phase === "error" && (
        <div className="px-5 py-2" style={{ fontSize: 11.5, color: color.danger, borderBottom: `1px solid ${color.cardBorder}` }}>
          {ed.exp.message} — <button onClick={() => ed.setExp({ phase: "idle" })} style={{ color: color.link, background: "none", border: "none", cursor: "pointer", padding: 0 }}>ลองใหม่</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ── ซ้าย 266px: การ์ดซับ ── */}
        <aside onScroll={ed.onListScroll} className="flex w-[266px] shrink-0 flex-col gap-2 overflow-y-auto p-3" style={{ borderRight: `1px solid ${color.cardBorder}`, background: color.bg1 }}>
          <GroupLabel>การ์ดซับ ({ed.captions.length})</GroupLabel>
          {ed.captions.map((c, i) => (
            <div
              key={`${i}-${c.startMs}`}
              ref={(el) => { ed.cardRefs.current[i] = el; }}
              onClick={() => { ed.setSelected(i); ed.setFollow(true); const v = ed.videoRef.current; if (v) v.currentTime = c.startMs / 1000 + 0.01; }}
              style={{ cursor: "pointer" }}
            >
              <Card
                selected={i === ed.selected}
                style={i === ed.activeIdx ? { boxShadow: `inset 2.5px 0 0 ${color.primary300}` } : undefined}
              >
                <div className="flex items-center justify-between" style={{ fontSize: 10.5 }}>
                  <span style={{ color: i === ed.selected ? color.primary300 : color.textFaint }}>
                    {fmtMs(c.startMs)}–{fmtMs(c.endMs)}{c.tag === "hook" ? " · HOOK" : c.tag === "cta" ? " · CTA" : ""}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); ed.setSelected(i); ed.setEditingIdx(ed.editingIdx === i ? null : i); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: color.textFaint, padding: 2 }}
                    aria-label="แก้ข้อความ"
                  >
                    <Pencil size={11} strokeWidth={1.7} />
                  </button>
                </div>
                {ed.editingIdx === i ? (
                  <textarea
                    autoFocus
                    value={c.text}
                    onChange={(e) => ed.setCaptions((caps) => caps.map((cc, ci) => ci === i ? { ...cc, text: e.target.value } : cc))}
                    onBlur={() => ed.setEditingIdx(null)}
                    className="mt-1 w-full resize-none bg-transparent outline-none"
                    rows={2}
                    style={{ fontSize: 12, lineHeight: 1.5, color: color.text, border: `1px solid ${color.selectedBorder}`, borderRadius: 8, padding: "4px 6px" }}
                  />
                ) : (
                  <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4, color: i === ed.selected ? color.text : color.textSecondary }}>
                    {c.text}
                  </div>
                )}
              </Card>
            </div>
          ))}
          {!ed.follow && (
            <button
              onClick={ed.resumeFollow}
              className="sticky bottom-1 z-10 mx-auto flex shrink-0 items-center gap-1.5"
              style={{
                padding: "5px 12px", borderRadius: radius.pill,
                background: color.selectedBg, border: `1px solid ${color.selectedBorder}`,
                color: color.primary300, fontSize: 11, cursor: "pointer",
                backdropFilter: "blur(6px)",
              }}
            >
              <ArrowDownToLine size={11} strokeWidth={2} /> ตามซับที่กำลังเล่น
            </button>
          )}
          <div className="mt-auto flex gap-2 pt-2">
            <button onClick={ed.mergeSelected} className="flex-1" style={{ padding: "7px 0", borderRadius: 9, background: "none", border: `1px solid ${color.cardBorder}`, color: color.textSecondary, fontSize: 11, cursor: "pointer" }}>
              รวมกับใบถัดไป
            </button>
            <button onClick={ed.splitSelected} className="flex-1" style={{ padding: "7px 0", borderRadius: 9, background: "none", border: `1px solid ${color.cardBorder}`, color: color.textSecondary, fontSize: 11, cursor: "pointer" }}>
              แยกการ์ด
            </button>
          </div>
        </aside>

        {/* ── กลาง: preview + ซับสด ── */}
        <main className="flex min-w-0 flex-1 items-center justify-center p-4" style={{ background: color.bg0 }}>
          <div className="relative" style={{ height: "min(72vh, 640px)", aspectRatio: "9/16", containerType: "size" }}>
            <video
              ref={ed.videoRef}
              src={ed.baseUrl}
              controls
              playsInline
              onTimeUpdate={(e) => ed.setTimeMs(e.currentTarget.currentTime * 1000)}
              onPlay={() => ed.setPlaying(true)}
              onPause={() => ed.setPlaying(false)}
              className="h-full w-full object-cover"
              style={{ borderRadius: radius.cardLg, border: `1px solid ${color.cardBorder}` }}
            />
            {/* เส้นไกด์ตำแหน่งซับ */}
            <div className="pointer-events-none absolute left-2 right-2" style={{ top: `${ed.cfg.verticalPos}%`, borderTop: "1px dashed rgba(255,255,255,.25)" }} />
            {/* ซับสด — renderer เดียวกับไฟล์ burn (WYSIWYG) + ลากปรับตำแหน่งได้ */}
            <V2CaptionOverlay
              captions={ed.captions}
              overrides={ed.overrides}
              cfg={ed.cfg}
              videoRef={ed.videoRef}
              playing={ed.playing}
              onVerticalPos={(p) => ed.set("verticalPos", p)}
            />
            {ed.adjustingAvatar && ed.canAdjustAvatar && ed.preview && (
              <AvatarAdjustOverlay
                avatarId={ed.preview.avatarModel!}
                avatarMode={ed.preview.avatarMode!}
                introSecs={ed.preview.avatarIntroSecs ?? 5}
                tailSecs={ed.preview.avatarTailSecs ?? 5}
                avatarVideoUrl={ed.preview.avatarVideoUrl!}
                tailAvatarUrl={ed.preview.tailAvatarUrl ?? null}
                bgVideoUrl={ed.preview.compositeBaseUrl!}
                jobId={job.jobId}
                onClose={() => ed.setAdjustingAvatar(false)}
                onDone={(url) => {
                  ed.setBaseUrl(url);
                  ed.setAdjustingAvatar(false);
                  const v = ed.videoRef.current;
                  if (v) { v.load(); v.currentTime = 0; }
                }}
              />
            )}
            {(ed.exp.phase === "burning" || ed.exp.phase === "saving") && (
              <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(10,10,16,.55)", borderRadius: radius.cardLg }}>
                <Loader2 size={22} className="animate-spin" color={color.primary300} />
              </div>
            )}
          </div>
        </main>

        {/* ── ขวา 330px: คุมซับ ── */}
        <aside className="flex w-[330px] shrink-0 flex-col gap-5 overflow-y-auto p-4" style={{ borderLeft: `1px solid ${color.cardBorder}`, background: color.bg1 }}>
          {ed.canAdjustAvatar && (
            <section className="flex flex-col gap-2">
              <GroupLabel>อวตาร</GroupLabel>
              <button
                onClick={() => {
                  const v = ed.videoRef.current;
                  if (v) { v.pause(); v.currentTime = 0; }
                  ed.setAdjustingAvatar(true);
                }}
                className="flex items-center justify-center gap-2"
                style={{
                  padding: "9px 0", borderRadius: radius.control, background: "rgba(139,92,246,.10)",
                  border: "1px solid rgba(139,92,246,.45)", color: color.primary300,
                  fontSize: 12, cursor: "pointer",
                }}
              >
                <Move size={13} /> ปรับตำแหน่ง/ขนาดอวตาร (ฟรี)
              </button>
              <span style={{ fontSize: 9.5, color: color.textFaintest }}>
                ตำแหน่งที่บันทึกจะถูกใช้เป็นค่าเริ่มต้นของอวตารนี้ในการเรนเดอร์ครั้งถัดไปด้วย
              </span>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <GroupLabel>ความยาวการ์ดซับ</GroupLabel>
            <Segmented
              value={ed.cardLen}
              onChange={(v) => ed.applyCardLen(v as V2CardLen)}
              options={V2_CARD_LEN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              style={{ flexWrap: "wrap" }}
            />
            <span style={{ fontSize: 9.5, color: color.textFaintest }}>
              ≤N คำ = ซับสั้นเด้งเร็วแบบ TikTok · เปลี่ยนแล้วจะล้างการรวม/แยก/สีรายการ์ดที่แก้ไว้
            </span>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>สไตล์แนะนำ</GroupLabel>
            <div className="grid grid-cols-2 gap-2">
              {V2_QUICK_STYLES.map((s) => {
                const active = ed.cfg.preset === s.preset && ed.cfg.effect === s.effect;
                return (
                  <button
                    key={s.key}
                    onClick={() => ed.setCfg((c) => ({ ...c, preset: s.preset, effect: s.effect }))}
                    className="flex flex-col items-start gap-1 text-left"
                    style={{
                      borderRadius: radius.card, padding: "10px 12px",
                      background: active ? color.selectedBg : color.cardBg,
                      border: `1px solid ${active ? color.selectedBorder : color.cardBorder}`,
                      cursor: "pointer", transition: "all 150ms ease",
                    }}
                  >
                    <span style={{ font: `500 12.5px ${font.heading}`, color: color.text }}>{s.label}</span>
                    <span style={{ fontSize: 10, color: active ? color.primary300 : color.textFaint }}>
                      {active ? "กำลังใช้" : s.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ปรับเอฟเฟกต์ได้ ({EDITABLE_EFFECT_PRESETS_DATA.length})</GroupLabel>
            <div className="grid grid-cols-3 gap-1.5">
              {EDITABLE_EFFECT_PRESETS_DATA.map((p) => (
                <button
                  key={p.value}
                  onClick={() => ed.set("preset", p.value)}
                  style={{
                    borderRadius: 9, padding: "7px 4px", fontSize: 10.5,
                    background: ed.cfg.preset === p.value ? color.selectedBg : color.cardBg,
                    border: `1px solid ${ed.cfg.preset === p.value ? color.selectedBorder : color.cardBorder}`,
                    color: ed.cfg.preset === p.value ? color.primary300 : color.textSecondary,
                    cursor: "pointer", transition: "all 150ms ease",
                    fontFamily: font.body,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>เอฟเฟกต์ติดมากับสไตล์ ({BUILT_IN_EFFECT_PRESETS_DATA.length})</GroupLabel>
            <div className="grid grid-cols-3 gap-1.5">
              {BUILT_IN_EFFECT_PRESETS_DATA.map((p) => (
                <button
                  key={p.value}
                  onClick={() => ed.set("preset", p.value)}
                  title="สไตล์นี้มีเอฟเฟกต์ในตัว"
                  style={{
                    borderRadius: 9, padding: "7px 4px", fontSize: 10.5,
                    background: ed.cfg.preset === p.value ? color.selectedBg : color.cardBg,
                    border: `1px solid ${ed.cfg.preset === p.value ? color.selectedBorder : color.cardBorder}`,
                    color: ed.cfg.preset === p.value ? color.primary300 : color.textSecondary,
                    cursor: "pointer", transition: "all 150ms ease",
                    fontFamily: font.body,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 9.5, color: color.textFaintest }}>
              เลือกกลุ่มนี้แล้วระบบจะใช้เอฟเฟกต์ประจำสไตล์แทนปุ่มเอฟเฟกต์ด้านล่าง
            </span>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>เอฟเฟกต์ตัวอักษร</GroupLabel>
            {LOCKED_EFFECT_PRESETS.includes(ed.cfg.preset) ? (
              <span style={{ fontSize: 10.5, color: color.textFaintest }}>สไตล์ &quot;{PRESETS_DATA.find((p) => p.value === ed.cfg.preset)?.label}&quot; กำหนดเอฟเฟกต์ในตัว</span>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {EFFECTS_DATA.map((ef) => (
                  <button
                    key={ef.value}
                    onClick={() => ed.set("effect", ef.value)}
                    title={ef.desc}
                    style={{
                      borderRadius: 9, padding: "7px 4px", fontSize: 10.5,
                      background: ed.cfg.effect === ef.value ? color.selectedBg : color.cardBg,
                      border: `1px solid ${ed.cfg.effect === ef.value ? color.selectedBorder : color.cardBorder}`,
                      color: ed.cfg.effect === ef.value ? color.primary300 : color.textSecondary,
                      cursor: "pointer", transition: "all 150ms ease", fontFamily: font.body,
                    }}
                  >
                    {ef.label}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ฟอนต์ · น้ำหนัก · ขนาด ({ed.cfg.fontSize}px)</GroupLabel>
            <div className="flex items-center gap-2">
              <select
                value={ed.cfg.fontFamily}
                onChange={(e) => ed.set("fontFamily", e.target.value)}
                className="flex-1 min-w-0"
                style={{ padding: "8px 10px", borderRadius: radius.control, fontSize: 12.5, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)", color: color.text, fontFamily: font.body }}
              >
                {FONTS_LIST.map((f) => <option key={f.value} value={f.value} style={{ background: color.bg1 }}>{f.label}</option>)}
              </select>
              <Segmented
                value={ed.cfg.bold ? "bold" : "regular"}
                onChange={(v) => ed.set("bold", v === "bold")}
                options={[{ value: "bold", label: "หนา" }, { value: "regular", label: "บาง" }]}
              />
            </div>
            <input
              type="range"
              min={30}
              max={160}
              value={ed.cfg.fontSize}
              onChange={(e) => ed.set("fontSize", Number(e.target.value))}
              style={{ accentColor: color.primary500 }}
            />
          </section>

          {(!LOCKED_COLOR_PRESETS.includes(ed.cfg.preset) || !LOCKED_ACCENT_PRESETS.includes(ed.cfg.preset)) && (
            <section className="flex flex-col gap-2">
              <GroupLabel>ใช้สีกับ</GroupLabel>
              <Segmented
                value={ed.scope}
                onChange={(v) => ed.setScope(v as "all" | "card")}
                options={[{ value: "all", label: "ทั้งคลิป" }, { value: "card", label: `การ์ดที่เลือก (#${ed.selected + 1})` }]}
              />
            </section>
          )}

          {!LOCKED_COLOR_PRESETS.includes(ed.cfg.preset) && (() => {
            const effective = ed.scope === "card" ? (ed.activeOverride.textColor ?? ed.cfg.textColor) : ed.cfg.textColor;
            return (
            <section className="flex flex-col gap-2">
              <GroupLabel>สีตัวอักษร{ed.scope === "card" ? ` · การ์ด #${ed.selected + 1}` : ""}</GroupLabel>
              <div className="flex items-center gap-2.5">
                {V2_TEXT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => ed.setColorScoped("textColor", c)}
                    aria-label={c}
                    className="h-[19px] w-[19px] rounded-full"
                    style={{
                      background: c, cursor: "pointer",
                      border: c === "#FFFFFF" || c === "#000000" ? "1px solid rgba(255,255,255,.25)" : "none",
                      outline: effective === c ? `1.5px solid ${color.primary500}` : "none",
                      outlineOffset: 2,
                    }}
                  />
                ))}
                <label className="relative h-[19px] w-[19px] cursor-pointer rounded-full" style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)", outline: !V2_TEXT_COLORS.includes(effective as typeof V2_TEXT_COLORS[number]) ? `1.5px solid ${color.primary500}` : "none", outlineOffset: 2 }}>
                  <input type="color" value={effective} onChange={(e) => ed.setColorScoped("textColor", e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="สีกำหนดเอง" />
                </label>
              </div>
            </section>
            );
          })()}

          {!LOCKED_ACCENT_PRESETS.includes(ed.cfg.preset) && (() => {
            const effective = ed.scope === "card" ? (ed.activeOverride.accentColor ?? ed.cfg.accentColor) : ed.cfg.accentColor;
            return (
            <section className="flex flex-col gap-2">
              <GroupLabel>สีเน้น HOOK · CTA{ed.scope === "card" ? ` · การ์ด #${ed.selected + 1}` : ""}</GroupLabel>
              <div className="flex items-center gap-2.5">
                {V2_ACCENT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => ed.setColorScoped("accentColor", c)}
                    aria-label={c}
                    className="h-[19px] w-[19px] rounded-full"
                    style={{ background: c, cursor: "pointer", outline: effective === c ? `1.5px solid ${color.primary500}` : "none", outlineOffset: 2 }}
                  />
                ))}
                <label className="relative h-[19px] w-[19px] cursor-pointer rounded-full" style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)", outline: !V2_ACCENT_COLORS.includes(effective as typeof V2_ACCENT_COLORS[number]) ? `1.5px solid ${color.primary500}` : "none", outlineOffset: 2 }}>
                  <input type="color" value={effective} onChange={(e) => ed.setColorScoped("accentColor", e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="สีเน้นกำหนดเอง" />
                </label>
              </div>
            </section>
            );
          })()}

          <section className="flex flex-col gap-2">
            <GroupLabel>เงา · เส้นขอบ</GroupLabel>
            <div className="flex items-center gap-4" style={{ fontSize: 12, color: color.textSecondary }}>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={ed.cfg.shadow} onChange={(e) => ed.set("shadow", e.target.checked)} style={{ accentColor: color.primary500 }} /> เงา
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={ed.cfg.outline} onChange={(e) => ed.set("outline", e.target.checked)} style={{ accentColor: color.primary500 }} /> เส้นขอบ
              </label>
              {ed.cfg.outline && (
                <input type="range" min={1} max={8} value={ed.cfg.outlineSize} onChange={(e) => ed.set("outlineSize", Number(e.target.value))} className="flex-1" style={{ accentColor: color.primary500 }} />
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <GroupLabel>ตำแหน่งแนวตั้ง ({ed.cfg.verticalPos}%)</GroupLabel>
            <input
              type="range"
              min={10}
              max={95}
              value={ed.cfg.verticalPos}
              onChange={(e) => ed.set("verticalPos", Number(e.target.value))}
              style={{ accentColor: color.primary500 }}
            />
            <Segmented
              value={ed.cfg.verticalPos <= 30 ? "top" : ed.cfg.verticalPos <= 62 ? "mid" : "bot"}
              onChange={(v) => ed.set("verticalPos", v === "top" ? 20 : v === "mid" ? 55 : 82)}
              options={[{ value: "top", label: "บน" }, { value: "mid", label: "กลาง" }, { value: "bot", label: "ล่าง" }]}
            />
          </section>

          <span style={{ fontSize: 10.5, color: color.textFaintest }}>
            ทิป: ลากซับบนจอเพื่อปรับตำแหน่ง · Space เล่น/หยุด · ←/→ ขยับ 1 วิ · Ctrl+Z เลิกทำ
          </span>
        </aside>
      </div>

      {/* Timeline 4 แทร็ก (P6b) — ซับลากขอบแก้เวลาได้, แทร็กอื่นคลิก jump */}
      <TimelinePanel
        captions={ed.captions}
        onCaptionsChange={ed.handleCaptionsChange}
        onUndo={ed.undoCaptions}
        canUndo={ed.historyLen > 0}
        selected={ed.selected}
        onSelect={ed.setSelected}
        videoRef={ed.videoRef}
        timeMs={ed.timeMs}
        onScrub={ed.setTimeMs}
        durationMs={Math.max(ed.preview?.audioDurationMs ?? 0, ed.captions.length ? ed.captions[ed.captions.length - 1].endMs : 0)}
        config={(ed.preview?.config as Record<string, unknown>) ?? null}
        hasAvatar={!!(ed.preview?.avatarModel && ed.preview.avatarModel !== "none")}
        avatarMode={ed.preview?.avatarMode ?? null}
        avatarIntroMs={(ed.preview?.avatarIntroSecs ?? 5) * 1000}
        avatarTailMs={(ed.preview?.avatarTailSecs ?? 5) * 1000}
        voiceUrl={ed.preview?.voiceUrl ?? null}
      />
    </div>
  );
}
