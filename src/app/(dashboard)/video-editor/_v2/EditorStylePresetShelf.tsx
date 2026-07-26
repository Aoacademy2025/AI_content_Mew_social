"use client";

import { useId, useState, type FormEvent } from "react";
import {
  BookmarkPlus,
  Check,
  LoaderCircle,
  Trash2,
  X,
} from "lucide-react";
import type {
  EditorStylePreset,
  EditorStylePresetKind,
} from "@/lib/editor-style-preset-contract";
import type { LogoPosition } from "@/lib/logo-overlay";
import { color, font, radius } from "./tokens";

const COPY: Record<EditorStylePresetKind, {
  title: string;
  empty: string;
  inputLabel: string;
  placeholder: string;
}> = {
  subtitle: {
    title: "พรีเซ็ตซับของฉัน",
    empty: "บันทึกฟอนต์ สี เอฟเฟกต์ และตำแหน่งไว้ใช้กับคลิปถัดไป",
    inputLabel: "ชื่อพรีเซ็ตซับ",
    placeholder: "เช่น คลิปความรู้",
  },
  logo: {
    title: "พรีเซ็ตโลโก้ของฉัน",
    empty: "บันทึกไฟล์ ตำแหน่ง ขนาด และความทึบไว้ใช้ซ้ำ",
    inputLabel: "ชื่อพรีเซ็ตโลโก้",
    placeholder: "เช่น แบรนด์หลัก มุมขวา",
  },
};

function logoDotStyle(position: LogoPosition) {
  const vertical = position.startsWith("top")
    ? { top: 5 }
    : position.startsWith("bottom")
      ? { bottom: 5 }
      : { top: "50%", marginTop: -2 };
  const horizontal = position.endsWith("left")
    ? { left: 5 }
    : position.endsWith("right")
      ? { right: 5 }
      : { left: "50%", marginLeft: -2 };
  return { ...vertical, ...horizontal };
}

function PresetMark({ preset }: { preset: EditorStylePreset }) {
  if (preset.kind === "subtitle") {
    return (
      <span className="preset-shelf__subtitle-mark" aria-hidden="true">
        <i style={{ background: preset.config.textColor }} />
        <i style={{ background: preset.config.accentColor }} />
      </span>
    );
  }
  return (
    <span className="preset-shelf__logo-mark" aria-hidden="true">
      <i style={logoDotStyle(preset.config.position)} />
    </span>
  );
}

export function EditorStylePresetShelf({
  kind,
  presets,
  loading,
  busy,
  canSave,
  saveDisabledHint,
  onSave,
  onApply,
  onRemove,
}: {
  kind: EditorStylePresetKind;
  presets: EditorStylePreset[];
  loading: boolean;
  busy: boolean;
  canSave: boolean;
  saveDisabledHint?: string;
  onSave: (name: string) => Promise<boolean>;
  onApply: (preset: EditorStylePreset) => void;
  onRemove: (preset: EditorStylePreset) => Promise<void>;
}) {
  const copy = COPY[kind];
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    if (await onSave(name)) {
      setName("");
      setEditing(false);
    }
  }

  return (
    <section className="preset-shelf" aria-labelledby={`${inputId}-heading`}>
      <header className="preset-shelf__header">
        <div>
          <span className="preset-shelf__eyebrow" id={`${inputId}-heading`}>
            <BookmarkPlus size={15} aria-hidden="true" />
            {copy.title}
          </span>
          <span>ใช้ซ้ำได้ทุกโปรเจกต์ในบัญชีนี้</span>
        </div>
        <button
          type="button"
          className="preset-shelf__save-trigger"
          disabled={!canSave || busy}
          title={!canSave ? saveDisabledHint : undefined}
          onClick={() => setEditing(true)}
        >
          {busy ? <LoaderCircle className="preset-shelf__spin" size={15} /> : <BookmarkPlus size={15} />}
          บันทึกค่าปัจจุบัน
        </button>
      </header>

      {editing && (
        <form className="preset-shelf__form" onSubmit={(event) => void submit(event)}>
          <label htmlFor={inputId}>{copy.inputLabel}</label>
          <div>
            <input
              id={inputId}
              value={name}
              maxLength={40}
              autoFocus
              autoComplete="off"
              placeholder={copy.placeholder}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="submit"
              className="preset-shelf__confirm"
              disabled={!name.trim() || busy}
              aria-label="บันทึกพรีเซ็ต"
            >
              {busy ? <LoaderCircle className="preset-shelf__spin" size={16} /> : <Check size={16} />}
            </button>
            <button
              type="button"
              className="preset-shelf__cancel"
              disabled={busy}
              aria-label="ยกเลิกการตั้งชื่อพรีเซ็ต"
              onClick={() => {
                setName("");
                setEditing(false);
              }}
            >
              <X size={16} />
            </button>
          </div>
          <span>ถ้าใช้ชื่อเดิม ระบบจะอัปเดตพรีเซ็ตนั้นด้วยค่าล่าสุด</span>
        </form>
      )}

      <div className="preset-shelf__body" aria-live="polite">
        {loading ? (
          <span className="preset-shelf__status">
            <LoaderCircle className="preset-shelf__spin" size={15} />
            กำลังโหลดพรีเซ็ต…
          </span>
        ) : presets.length === 0 ? (
          <span className="preset-shelf__empty">{copy.empty}</span>
        ) : (
          <ul className="preset-shelf__list">
            {presets.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  className="preset-shelf__apply"
                  disabled={busy}
                  title={`ใช้พรีเซ็ต ${preset.name}`}
                  onClick={() => onApply(preset)}
                >
                  <PresetMark preset={preset} />
                  <span>{preset.name}</span>
                </button>
                <button
                  type="button"
                  className="preset-shelf__remove"
                  disabled={busy}
                  aria-label={`ลบพรีเซ็ต ${preset.name}`}
                  title={`ลบ ${preset.name}`}
                  onClick={() => void onRemove(preset)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <style>{`
        .preset-shelf {
          display: grid;
          gap: 12px;
          padding: 13px;
          color: ${color.text};
          font-family: ${font.body};
          border: 1px solid ${color.selectedBorder};
          border-radius: ${radius.card}px;
          background: linear-gradient(145deg, ${color.selectedBg}, rgba(255,255,255,.015) 65%);
        }
        .preset-shelf button,
        .preset-shelf input { font: inherit; }
        .preset-shelf button:focus-visible,
        .preset-shelf input:focus-visible {
          outline: 2px solid ${color.primary300};
          outline-offset: 2px;
        }
        .preset-shelf button:disabled,
        .preset-shelf input:disabled { cursor: not-allowed; opacity: .48; }
        .preset-shelf__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .preset-shelf__header > div { min-width: 0; display: grid; gap: 3px; }
        .preset-shelf__header > div > span:last-child,
        .preset-shelf__form > span,
        .preset-shelf__empty,
        .preset-shelf__status {
          color: ${color.textFaint};
          font-size: 10.5px;
          line-height: 1.45;
        }
        .preset-shelf__eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          color: ${color.text};
          font: 600 12.5px ${font.heading};
        }
        .preset-shelf__eyebrow svg { color: ${color.primary300}; }
        .preset-shelf__save-trigger {
          min-height: 44px;
          flex: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 6px 9px;
          color: ${color.primary300};
          font-size: 10.5px;
          font-weight: 600;
          background: rgba(139,92,246,.08);
          border: 1px solid ${color.selectedBorder};
          border-radius: ${radius.control}px;
          cursor: pointer;
        }
        .preset-shelf__form {
          display: grid;
          gap: 7px;
          padding-top: 11px;
          border-top: 1px solid ${color.cardBorder};
        }
        .preset-shelf__form label {
          color: ${color.textSecondary};
          font-size: 11px;
          font-weight: 600;
        }
        .preset-shelf__form > div {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 44px 44px;
          gap: 6px;
        }
        .preset-shelf__form input {
          min-width: 0;
          min-height: 44px;
          padding: 8px 10px;
          color: ${color.text};
          background: rgba(10,10,16,.65);
          border: 1px solid ${color.cardBorder};
          border-radius: ${radius.control}px;
        }
        .preset-shelf__form input::placeholder { color: ${color.textFaintest}; }
        .preset-shelf__confirm,
        .preset-shelf__cancel {
          min-width: 44px;
          min-height: 44px;
          display: grid;
          place-items: center;
          border-radius: ${radius.control}px;
          cursor: pointer;
        }
        .preset-shelf__confirm {
          color: ${color.text};
          background: ${color.gradientPrimary};
          border: 0;
        }
        .preset-shelf__cancel {
          color: ${color.textSecondary};
          background: ${color.cardBg};
          border: 1px solid ${color.cardBorder};
        }
        .preset-shelf__body { min-width: 0; }
        .preset-shelf__status {
          min-height: 32px;
          display: flex;
          align-items: center;
          gap: 7px;
        }
        .preset-shelf__empty { display: block; padding: 2px 0; }
        .preset-shelf__list {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          margin: 0;
          padding: 0;
          list-style: none;
        }
        .preset-shelf__list li {
          min-width: 0;
          display: grid;
          grid-template-columns: minmax(0, auto) 44px;
          overflow: hidden;
          border: 1px solid ${color.cardBorder};
          border-radius: ${radius.control}px;
          background: rgba(10,10,16,.5);
        }
        .preset-shelf__list li:hover { border-color: ${color.selectedBorder}; }
        .preset-shelf__apply {
          min-width: 0;
          min-height: 44px;
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 6px 5px 6px 8px;
          color: ${color.textSecondary};
          background: none;
          border: 0;
          cursor: pointer;
        }
        .preset-shelf__apply > span:last-child {
          max-width: 126px;
          overflow: hidden;
          font-size: 11px;
          font-weight: 600;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .preset-shelf__remove {
          min-width: 44px;
          min-height: 44px;
          display: grid;
          place-items: center;
          color: ${color.textFaint};
          background: none;
          border: 0;
          border-left: 1px solid ${color.cardBorder};
          cursor: pointer;
        }
        .preset-shelf__remove:hover { color: ${color.danger}; }
        .preset-shelf__subtitle-mark {
          width: 22px;
          height: 18px;
          flex: none;
          display: flex;
          align-items: center;
          padding-left: 2px;
        }
        .preset-shelf__subtitle-mark i {
          width: 12px;
          height: 12px;
          display: block;
          border: 1px solid rgba(255,255,255,.3);
          border-radius: 50%;
        }
        .preset-shelf__subtitle-mark i + i { margin-left: -4px; }
        .preset-shelf__logo-mark {
          width: 22px;
          height: 22px;
          flex: none;
          position: relative;
          display: block;
          border: 1px solid rgba(255,255,255,.18);
          border-radius: 6px;
        }
        .preset-shelf__logo-mark i {
          width: 5px;
          height: 5px;
          position: absolute;
          display: block;
          background: ${color.primary300};
          border-radius: 50%;
        }
        .preset-shelf__spin { animation: preset-shelf-spin 800ms linear infinite; }
        @keyframes preset-shelf-spin { to { transform: rotate(360deg); } }
        @media (max-width: 520px) {
          .preset-shelf__header { align-items: stretch; flex-direction: column; }
          .preset-shelf__save-trigger { width: 100%; }
        }
      `}</style>
    </section>
  );
}
