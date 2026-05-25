import type { SubPreset, SubTextEffect } from "./types";

export const PRESETS_DATA: { value: SubPreset; label: string }[] = [
  { value: "stroke",        label: "มาตรฐาน" },
  { value: "plain",         label: "มินิมอล" },
  { value: "bold-shadow",   label: "ตัวหนา" },
  { value: "neon-green",    label: "น็ออนเขียว" },
  { value: "neon-red",      label: "ไฟแดง" },
  { value: "neon-blue",     label: "ไฟฟ้า" },
  { value: "karaoke-box",   label: "คาราโอเกะ" },
  { value: "pop-outline",   label: "ป๊อปไลน์" },
  { value: "pastel",        label: "พาสเทล" },
  { value: "classic-yellow",label: "คลาสสิก" },
  { value: "hormozi",       label: "Hormozi" },
  { value: "beast",         label: "Beast" },
  { value: "box-white",     label: "กล่องขาว" },
  { value: "box-yellow",    label: "กล่องเหลือง" },
  { value: "retro",         label: "เรโทร" },
  { value: "sharp-outline", label: "เส้นขอบชัด" },
  { value: "news",          label: "ข่าว" },
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

export const FONTS_LIST: { label: string; value: string; preview: string }[] = [
  { label: "Mitr",              value: "'Mitr', sans-serif",                preview: "สวัสดี Abc" },
  { label: "Kanit",             value: "'Kanit', sans-serif",               preview: "สวัสดี Abc" },
  { label: "Sarabun",           value: "'Sarabun', sans-serif",             preview: "สวัสดี Abc" },
  { label: "Prompt",            value: "'Prompt', sans-serif",              preview: "สวัสดี Abc" },
  { label: "Noto Sans Thai",    value: "'Noto Sans Thai', sans-serif",      preview: "สวัสดี Abc" },
  { label: "IBM Plex Thai",     value: "'IBM Plex Sans Thai', sans-serif",  preview: "สวัสดี Abc" },
  { label: "Chakra Petch",      value: "'Chakra Petch', sans-serif",        preview: "สวัสดี Abc" },
  { label: "Chonburi",          value: "'Chonburi', serif",                 preview: "สวัสดี Abc" },
  { label: "Fahkwang",          value: "'Fahkwang', sans-serif",            preview: "สวัสดี Abc" },
  { label: "Itim",              value: "'Itim', cursive",                   preview: "สวัสดี Abc" },
  { label: "Sriracha",          value: "'Sriracha', cursive",               preview: "สวัสดี Abc" },
  { label: "Bangers",           value: "'Bangers', cursive",                preview: "Abc 123" },
  { label: "Bebas Neue",        value: "'Bebas Neue', cursive",             preview: "ABC 123" },
  { label: "Oswald",            value: "'Oswald', sans-serif",              preview: "Abc 123" },
  { label: "Anton",             value: "'Anton', sans-serif",               preview: "ABC 123" },
  { label: "Righteous",         value: "'Righteous', cursive",              preview: "Abc 123" },
  { label: "Playfair Display",  value: "'Playfair Display', serif",         preview: "Abc 123" },
  { label: "Pacifico",          value: "'Pacifico', cursive",               preview: "Abc 123" },
  { label: "Lobster",           value: "'Lobster', cursive",                preview: "Abc 123" },
];

export const ACCENT_COLORS_LIST = ["#FFE500","#FF3B30","#34C759","#007AFF","#AF52DE","#FF9500","#ffffff","#000000"];
export const TEXT_COLORS_LIST  = ["#ffffff","#FFE500","#4ade80","#f9a8d4","#22d3ee","#f87171","#fbbf24","#000000"];
