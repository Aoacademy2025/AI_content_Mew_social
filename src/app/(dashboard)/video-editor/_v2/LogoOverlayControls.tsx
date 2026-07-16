"use client";

import { useId, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import {
  Check,
  Crown,
  Image as ImageIcon,
  LockKeyhole,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  LOGO_POSITIONS,
  MAX_LOGO_OPACITY,
  MAX_LOGO_SIZE_PCT,
  MIN_LOGO_OPACITY,
  MIN_LOGO_SIZE_PCT,
  normalizeLogoOverlayConfig,
  type LogoOverlayConfig,
  type LogoPosition,
} from "@/lib/logo-overlay";
import { color, font, radius } from "./tokens";
import {
  LOGO_PICKER_ACCEPT,
  LOGO_PICKER_FORMAT_LABEL,
  type LogoOverlayEditor,
} from "./useLogoOverlayEditor";

const POSITION_LABELS: Record<LogoPosition, string> = {
  "top-left": "ซ้ายบน",
  "top-center": "กึ่งกลางด้านบน",
  "top-right": "ขวาบน",
  "middle-left": "กึ่งกลางด้านซ้าย",
  center: "กึ่งกลาง",
  "middle-right": "กึ่งกลางด้านขวา",
  "bottom-left": "ซ้ายล่าง",
  "bottom-center": "กึ่งกลางด้านล่าง",
  "bottom-right": "ขวาล่าง",
};

function dotPosition(position: LogoPosition): CSSProperties {
  const vertical = position.startsWith("top")
    ? { top: 7 }
    : position.startsWith("bottom")
      ? { bottom: 7 }
      : { top: "50%", transform: "translateY(-50%)" };
  const horizontal = position.endsWith("left")
    ? { left: 7 }
    : position.endsWith("right")
      ? { right: 7 }
      : { left: "50%", marginLeft: -4 };
  return { ...vertical, ...horizontal };
}

function LockedNotice() {
  return (
    <div className="logo-controls__locked" role="note">
      <LockKeyhole size={17} aria-hidden="true" />
      <div>
        <strong>Logo Overlay สำหรับ Pro และ Business</strong>
        <span>อัปเกรดเพื่ออัปโหลดและปรับโลโก้แบรนด์ในวิดีโอ</span>
      </div>
    </div>
  );
}

function LogoSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="logo-controls__switch"
      role="switch"
      aria-label="แสดงโลโก้ในโปรเจกต์นี้"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span
        className="logo-controls__switch-track"
        data-on={checked ? "true" : "false"}
      >
        <span />
      </span>
    </button>
  );
}

export function LogoOverlayControls({
  value,
  eligible,
  editor,
}: {
  value: LogoOverlayConfig | undefined;
  eligible: boolean;
  editor: LogoOverlayEditor;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [offerDefault, setOfferDefault] = useState(false);
  const positionLabelId = useId();
  const config = normalizeLogoOverlayConfig(value);
  const controlsDisabled = !eligible || editor.saving;

  const chooseFile = () => {
    if (!controlsDisabled) fileInputRef.current?.click();
  };

  const onFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setOfferDefault(false);
    if (await editor.upload(file)) setOfferDefault(true);
  };

  const makeDefault = async () => {
    if (await editor.saveAsDefault()) setOfferDefault(false);
  };

  return (
    <section className="logo-controls" aria-label="ตั้งค่า Logo Overlay">
      <input
        ref={fileInputRef}
        className="logo-controls__file"
        type="file"
        accept={LOGO_PICKER_ACCEPT}
        aria-label="เลือกไฟล์โลโก้"
        tabIndex={-1}
        disabled={controlsDisabled}
        onChange={onFileSelected}
      />

      {!eligible && <LockedNotice />}

      {!config ? (
        <div className="logo-controls__empty">
          <div className="logo-controls__empty-mark" aria-hidden="true">
            <ImageIcon size={22} />
          </div>
          <div className="logo-controls__empty-copy">
            <h3>ใส่แบรนด์ของคุณในคลิป</h3>
            <p>เพิ่มโลโก้เหนือวิดีโอและเห็นตำแหน่งจริงก่อนส่งออก</p>
          </div>
          <button
            type="button"
            className="logo-controls__upload"
            disabled={controlsDisabled}
            onClick={chooseFile}
          >
            {editor.saving ? <RefreshCw className="logo-controls__spin" size={17} /> : <Upload size={17} />}
            {editor.saving ? "กำลังอัปโหลด…" : "อัปโหลดโลโก้"}
          </button>
          <span className="logo-controls__format">{LOGO_PICKER_FORMAT_LABEL}</span>
        </div>
      ) : (
        <>
          <div className="logo-controls__enable-row">
            <div>
              <strong>แสดงโลโก้ในโปรเจกต์นี้</strong>
              <span>{config.enabled ? "โลโก้จะแสดงตลอดทั้งคลิป" : "เก็บการตั้งค่าไว้ แต่ไม่แสดงในคลิป"}</span>
            </div>
            <LogoSwitch
              checked={config.enabled}
              disabled={controlsDisabled}
              onChange={editor.setEnabled}
            />
          </div>

          <div className="logo-controls__asset-row">
            <div className="logo-controls__thumb">
              {editor.asset ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={editor.asset.imageUrl} alt={`โลโก้ ${editor.asset.displayName}`} />
              ) : editor.loading ? (
                <RefreshCw className="logo-controls__spin" size={18} aria-label="กำลังโหลดโลโก้" />
              ) : (
                <ImageIcon size={19} aria-hidden="true" />
              )}
            </div>
            <div className="logo-controls__asset-name">
              <strong>{editor.asset?.displayName ?? (editor.loading ? "กำลังโหลดโลโก้…" : "โลโก้ปัจจุบัน")}</strong>
              <span>{editor.asset ? `${editor.asset.width} × ${editor.asset.height} px` : "ไฟล์ส่วนตัวของบัญชีคุณ"}</span>
            </div>
            <button
              type="button"
              className="logo-controls__text-action"
              disabled={controlsDisabled}
              onClick={chooseFile}
            >
              เปลี่ยน
            </button>
            <button
              type="button"
              className="logo-controls__remove-action"
              disabled={controlsDisabled}
              onClick={() => {
                setOfferDefault(false);
                editor.removeFromProject();
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              ลบออกจากโปรเจกต์
            </button>
          </div>

          <div className="logo-controls__section">
            <div className="logo-controls__section-heading">
              <label id={positionLabelId}>ตำแหน่ง</label>
              <output>{POSITION_LABELS[config.position]}</output>
            </div>
            <div
              className="logo-controls__position-grid"
              role="group"
              aria-labelledby={positionLabelId}
            >
              {LOGO_POSITIONS.map((position) => {
                const selected = position === config.position;
                return (
                  <button
                    key={position}
                    type="button"
                    className="logo-controls__position"
                    aria-label={`วางโลโก้${POSITION_LABELS[position]}`}
                    aria-pressed={selected}
                    disabled={controlsDisabled}
                    data-selected={selected ? "true" : "false"}
                    onClick={() => editor.setPosition(position)}
                  >
                    <span style={dotPosition(position)} />
                    {selected && <Check size={12} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="logo-controls__section logo-controls__sliders">
            <label className="logo-controls__range-row">
              <span>
                <strong>ขนาด</strong>
                <output>{Math.round(config.sizePct)}%</output>
              </span>
              <input
                type="range"
                min={MIN_LOGO_SIZE_PCT}
                max={MAX_LOGO_SIZE_PCT}
                step={1}
                value={config.sizePct}
                disabled={controlsDisabled}
                aria-label="ขนาดโลโก้"
                aria-valuetext={`${Math.round(config.sizePct)} เปอร์เซ็นต์`}
                onChange={(event) => editor.setSizePct(Number(event.target.value))}
              />
            </label>
            <label className="logo-controls__range-row">
              <span>
                <strong>ความทึบ</strong>
                <output>{Math.round(config.opacity * 100)}%</output>
              </span>
              <input
                type="range"
                min={MIN_LOGO_OPACITY * 100}
                max={MAX_LOGO_OPACITY * 100}
                step={1}
                value={config.opacity * 100}
                disabled={controlsDisabled}
                aria-label="ความทึบของโลโก้"
                aria-valuetext={`${Math.round(config.opacity * 100)} เปอร์เซ็นต์`}
                onChange={(event) => editor.setOpacity(Number(event.target.value) / 100)}
              />
            </label>
          </div>

          {offerDefault && (
            <div className="logo-controls__default-choice" aria-label="เลือกการใช้โลโก้">
              <div>
                <Crown size={17} aria-hidden="true" />
                <strong>ใช้โลโก้นี้กับโปรเจกต์แบบไหน?</strong>
              </div>
              <button
                type="button"
                disabled={editor.saving}
                onClick={() => setOfferDefault(false)}
              >
                ใช้เฉพาะโปรเจกต์นี้
              </button>
              <button
                type="button"
                className="logo-controls__default-action"
                disabled={editor.saving}
                onClick={() => void makeDefault()}
              >
                ตั้งเป็นโลโก้หลักสำหรับโปรเจกต์ใหม่
              </button>
            </div>
          )}
        </>
      )}

      {editor.error && (
        <div className="logo-controls__error" role="alert">
          <span>{editor.error}</span>
          {editor.error === "ยังไม่ได้บันทึก" && (
            <button type="button" onClick={editor.retryProjectSave}>
              ลองบันทึกอีกครั้ง
            </button>
          )}
        </div>
      )}

      <style>{`
        .logo-controls {
          display: grid;
          gap: 20px;
          color: ${color.text};
          font-family: ${font.body};
          container-type: inline-size;
        }
        .logo-controls button,
        .logo-controls input { font: inherit; }
        .logo-controls button:focus-visible,
        .logo-controls input:focus-visible {
          outline: 2px solid ${color.primary300};
          outline-offset: 3px;
        }
        .logo-controls button:disabled,
        .logo-controls input:disabled { cursor: not-allowed; opacity: .48; }
        .logo-controls__file {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          white-space: nowrap;
        }
        .logo-controls__locked {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 12px 0 16px;
          color: ${color.warning};
          border-bottom: 1px solid ${color.cardBorder};
        }
        .logo-controls__locked div { display: grid; gap: 3px; }
        .logo-controls__locked strong { color: ${color.text}; font: 600 13px ${font.heading}; }
        .logo-controls__locked span { color: ${color.textSecondary}; font-size: 12px; line-height: 1.5; }
        .logo-controls__empty {
          min-height: 220px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          gap: 14px;
          padding: 12px 2px;
        }
        .logo-controls__empty-mark {
          width: 44px;
          height: 44px;
          display: grid;
          place-items: center;
          color: ${color.primary300};
          border-radius: ${radius.iconTile}px;
          background: ${color.selectedBg};
          border: 1px solid ${color.selectedBorder};
        }
        .logo-controls__empty-copy { display: grid; gap: 5px; max-width: 270px; }
        .logo-controls__empty h3 { margin: 0; font: 600 17px ${font.heading}; }
        .logo-controls__empty p { margin: 0; color: ${color.textSecondary}; font-size: 13px; line-height: 1.6; }
        .logo-controls__upload {
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 9px;
          padding: 10px 16px;
          color: ${color.primary300};
          font-weight: 600;
          background: ${color.selectedBg};
          border: 1px solid ${color.selectedBorderStrong};
          border-radius: ${radius.control}px;
          cursor: pointer;
        }
        .logo-controls__format { color: ${color.textFaint}; font-size: 11.5px; }
        .logo-controls__enable-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding-bottom: 16px;
          border-bottom: 1px solid ${color.cardBorder};
        }
        .logo-controls__enable-row > div { display: grid; gap: 3px; }
        .logo-controls__enable-row strong { font: 600 13px ${font.heading}; }
        .logo-controls__enable-row span { color: ${color.textSecondary}; font-size: 11.5px; line-height: 1.45; }
        .logo-controls__switch {
          width: 52px;
          min-width: 52px;
          height: 44px;
          padding: 8px 2px;
          display: grid;
          place-items: center;
          background: none;
          border: 0;
          cursor: pointer;
        }
        .logo-controls__switch-track {
          width: 44px;
          height: 26px;
          display: block;
          position: relative;
          border-radius: 999px;
          background: rgba(255,255,255,.12);
          border: 1px solid ${color.cardBorder};
          transition: background 150ms ease, border-color 150ms ease;
        }
        .logo-controls__switch-track[data-on="true"] {
          background: ${color.primary500};
          border-color: ${color.selectedBorderStrong};
        }
        .logo-controls__switch-track > span {
          position: absolute;
          width: 20px;
          height: 20px;
          top: 2px;
          left: 2px;
          border-radius: 50%;
          background: ${color.text};
          transition: transform 150ms ease;
        }
        .logo-controls__switch-track[data-on="true"] > span { transform: translateX(18px); }
        .logo-controls__asset-row {
          display: grid;
          grid-template-columns: 52px minmax(0, 1fr) auto;
          align-items: center;
          gap: 10px;
          padding: 10px;
          background: ${color.cardBg};
          border: 1px solid ${color.cardBorder};
          border-radius: ${radius.card}px;
        }
        .logo-controls__thumb {
          width: 52px;
          height: 52px;
          display: grid;
          place-items: center;
          overflow: hidden;
          color: ${color.textFaint};
          border-radius: ${radius.iconTile}px;
          background: rgba(255,255,255,.07);
        }
        .logo-controls__thumb img { width: 100%; height: 100%; object-fit: contain; }
        .logo-controls__asset-name { min-width: 0; display: grid; gap: 3px; }
        .logo-controls__asset-name strong,
        .logo-controls__asset-name span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .logo-controls__asset-name strong { font-size: 12.5px; font-weight: 600; }
        .logo-controls__asset-name span { color: ${color.textFaint}; font-size: 10.5px; }
        .logo-controls__text-action,
        .logo-controls__remove-action {
          min-height: 44px;
          color: ${color.primary300};
          background: none;
          border: 0;
          cursor: pointer;
        }
        .logo-controls__text-action { padding: 0 8px; font-size: 12px; font-weight: 600; }
        .logo-controls__remove-action {
          grid-column: 2 / -1;
          display: inline-flex;
          align-items: center;
          justify-self: start;
          gap: 7px;
          padding: 0 8px 0 0;
          color: ${color.danger};
          font-size: 12px;
        }
        .logo-controls__section {
          display: grid;
          gap: 12px;
          padding-top: 18px;
          border-top: 1px solid ${color.cardBorder};
        }
        .logo-controls__section-heading,
        .logo-controls__range-row > span {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .logo-controls__section-heading label,
        .logo-controls__range-row strong { font-size: 12.5px; font-weight: 600; }
        .logo-controls__section-heading output,
        .logo-controls__range-row output {
          color: ${color.primary300};
          font: 600 12px ${font.heading};
          font-variant-numeric: tabular-nums;
        }
        .logo-controls__position-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(44px, 1fr));
          gap: 8px;
        }
        .logo-controls__position {
          min-width: 44px;
          min-height: 44px;
          position: relative;
          display: grid;
          place-items: center;
          color: ${color.primary300};
          background: rgba(255,255,255,.035);
          border: 1px solid ${color.cardBorder};
          border-radius: ${radius.control}px;
          cursor: pointer;
        }
        .logo-controls__position:hover:not(:disabled) { background: rgba(255,255,255,.07); }
        .logo-controls__position[data-selected="true"] {
          background: ${color.selectedBg};
          border-color: ${color.selectedBorderStrong};
        }
        .logo-controls__position > span {
          width: 8px;
          height: 8px;
          position: absolute;
          border-radius: 50%;
          background: currentColor;
        }
        .logo-controls__position > svg { opacity: .85; }
        .logo-controls__sliders { gap: 18px; }
        .logo-controls__range-row { display: grid; gap: 6px; }
        .logo-controls__range-row input {
          width: 100%;
          height: 44px;
          margin: 0;
          accent-color: ${color.primary500};
          cursor: pointer;
        }
        .logo-controls__range-row input::-webkit-slider-thumb { width: 22px; height: 22px; }
        .logo-controls__range-row input::-moz-range-thumb { width: 22px; height: 22px; }
        .logo-controls__default-choice {
          display: grid;
          gap: 8px;
          padding-top: 18px;
          border-top: 1px solid ${color.selectedBorder};
        }
        .logo-controls__default-choice > div {
          display: flex;
          align-items: center;
          gap: 9px;
          color: ${color.primary300};
          margin-bottom: 2px;
        }
        .logo-controls__default-choice strong { color: ${color.text}; font-size: 12.5px; }
        .logo-controls__default-choice > button {
          min-height: 44px;
          padding: 9px 12px;
          text-align: left;
          color: ${color.textSecondary};
          background: none;
          border: 1px solid ${color.cardBorder};
          border-radius: ${radius.control}px;
          cursor: pointer;
        }
        .logo-controls__default-choice > .logo-controls__default-action {
          color: ${color.primary300};
          background: ${color.selectedBg};
          border-color: ${color.selectedBorder};
          font-weight: 600;
        }
        .logo-controls__error {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          color: ${color.danger};
          font-size: 12px;
          line-height: 1.45;
        }
        .logo-controls__error button {
          min-height: 44px;
          flex: none;
          padding: 0 8px;
          color: ${color.primary300};
          background: none;
          border: 0;
          font-weight: 600;
          cursor: pointer;
        }
        .logo-controls__spin { animation: logo-controls-spin 900ms linear infinite; }
        @keyframes logo-controls-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .logo-controls *, .logo-controls *::before, .logo-controls *::after {
            scroll-behavior: auto !important;
            transition-duration: .01ms !important;
            animation-duration: .01ms !important;
            animation-iteration-count: 1 !important;
          }
        }
        @container (max-width: 274px) {
          .logo-controls__asset-row { grid-template-columns: 52px minmax(0, 1fr); }
          .logo-controls__text-action { grid-column: 2; justify-self: start; padding: 0; }
          .logo-controls__remove-action { grid-column: 2; }
        }
        @media (pointer: coarse) {
          .logo-controls__position { min-height: 48px; }
          .logo-controls__range-row input { height: 48px; }
        }
      `}</style>
    </section>
  );
}
