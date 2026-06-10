import type { SubPreset, SubTextEffect } from "./types";

// Order kept in sync with /video-creator's Caption Style grid (page.tsx)
export const PRESETS_DATA: { value: SubPreset; label: string }[] = [
  { value: "stroke",        label: "มาตรฐาน" },
  { value: "plain",         label: "มินิมอล" },
  { value: "bold-shadow",   label: "ตัวหนาเด่น" },
  { value: "neon-green",    label: "นีออนเขียว" },
  { value: "karaoke-box",   label: "คาราโอเกะ" },
  { value: "pop-outline",   label: "ป็อปไลน์" },
  { value: "pastel",        label: "พาสเทล" },
  { value: "classic-yellow",label: "คลาสสิก" },
  { value: "hormozi",       label: "Hormozi" },
  { value: "beast",         label: "Beast" },
  { value: "box-white",     label: "กล่องขาว" },
  { value: "box-yellow",    label: "กล่องเหลือง" },
  { value: "retro",         label: "เรโทร" },
  { value: "sharp-outline", label: "เส้นขอบชัด" },
  { value: "news",          label: "ข่าว" },
  { value: "neon-red",      label: "ไฟแดง" },
  { value: "neon-blue",     label: "ไฟฟ้า" },
];

export const EFFECTS_DATA: { value: SubTextEffect; label: string; desc: string }[] = [
  { value: "pop",        label: "ป๊อป",       desc: "กระโดดเข้า" },
  { value: "bounce",     label: "เด้ง",        desc: "สปริงกระดอน" },
  { value: "fade",       label: "เฟด",        desc: "ค่อยๆ ปรากฏ" },
  { value: "quick",      label: "สั้น",        desc: "กระชับรวดเร็ว" },
  { value: "glow-pulse", label: "เรืองแสง",   desc: "กะพริบเรืองแสง" },
  { value: "slide",      label: "สไลด์",      desc: "เลื่อนขึ้นจากล่าง" },
  { value: "flip",       label: "หมุนชุม",    desc: "พลิกมุมมอง" },
  { value: "highlight",  label: "ไฮไลท์",     desc: "แถบไฮไลท์" },
  { value: "karaoke",    label: "คาราโอเกะ",  desc: "ทีละคำ" },
  { value: "typewriter", label: "พิมพ์ดีด",   desc: "ทีละตัว" },
];

// Order/labels kept in sync with /video-creator's Font select (page.tsx)
export const FONTS_LIST: { label: string; value: string; preview: string }[] = [
  { label: "Kanit — หนา ชัด",           value: "'Kanit', sans-serif",               preview: "สวัสดี Abc" },
  { label: "Sarabun — อ่านง่าย",        value: "'Sarabun', sans-serif",             preview: "สวัสดี Abc" },
  { label: "Prompt — โมเดิร์น",         value: "'Prompt', sans-serif",              preview: "สวัสดี Abc" },
  { label: "Mitr — TikTok",              value: "'Mitr', sans-serif",                preview: "สวัสดี Abc" },
  { label: "Noto Sans Thai",             value: "'Noto Sans Thai', sans-serif",      preview: "สวัสดี Abc" },
  { label: "K2D — กลม น่ารัก",          value: "'K2D', sans-serif",                 preview: "สวัสดี Abc" },
  { label: "Bai Jamjuree — คมชัด",      value: "'Bai Jamjuree', sans-serif",        preview: "สวัสดี Abc" },
  { label: "Krub — เรียบร้อย",           value: "'Krub', sans-serif",                preview: "สวัสดี Abc" },
  { label: "Pridi — สง่างาม",            value: "'Pridi', serif",                    preview: "สวัสดี Abc" },
  { label: "Chonburi — ตัวหนา display",  value: "'Chonburi', sans-serif",            preview: "สวัสดี Abc" },
  { label: "Itim — น่ารัก ลายมือ",       value: "'Itim', cursive",                   preview: "สวัสดี Abc" },
  { label: "IBM Plex Sans Thai",         value: "'IBM Plex Sans Thai', sans-serif",  preview: "สวัสดี Abc" },
];

export const ACCENT_COLORS_LIST = ["#FFE500","#FF3B30","#34C759","#007AFF","#AF52DE","#FF9500","#ffffff","#000000"];
export const TEXT_COLORS_LIST  = ["#ffffff","#FFE500","#4ade80","#f9a8d4","#22d3ee","#f87171","#fbbf24","#000000"];
