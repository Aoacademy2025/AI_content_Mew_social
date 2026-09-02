import type { ActiveVisualFormatId } from "@/lib/brand-visual-system";
import type { TreatmentPresetId } from "@/lib/brand-treatment-catalog";
import type { SubtitleStylePresetConfig } from "@/lib/editor-style-preset-contract";

/** Style Pack catalog V1 — encodes docs/audits/2026-09-02-brands-review.md §8.
 * Wave 1 (packs 1-7) ships active; wave 2 (packs 8-12) is `pending-benchmark`
 * until its narrative treatment clears the Treatment Qualification Benchmark
 * (ADR 0010) — pending packs are never customer-visible and never recommended. */

export const STYLE_PACK_IDS = [
  "thai-ghost",
  "thai-history",
  "life-drama",
  "finance-clear",
  "news-fast",
  "health-simple",
  "premium-product",
  "dark-story",
  "politics",
  "mystery",
  "dharma",
  "motivation",
] as const;
export type StylePackId = (typeof STYLE_PACK_IDS)[number];

export type StylePackStatus = "active" | "pending-benchmark";
export type PacingLevel = "slow" | "normal" | "fast";

export const MUSIC_MOODS = [
  "ominous",
  "tense",
  "emotional",
  "upbeat",
  "calm",
  "epic",
  "serious",
  "lounge",
  "traditional",
  "eerie",
] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

/** Treatment ids the catalog may reference; wave 2 adds the last five to
 * TreatmentPresetId once their narrative treatment ships. */
export type StylePackTreatmentId =
  | TreatmentPresetId
  | "dark-story-true-crime"
  | "political-commentary"
  | "mystery-unexplained"
  | "dharma-storytelling"
  | "stoic-motivation";

export type StockMood = {
  queryToken: string; // ONE lowercase English token appended to primary stock queries
  positive: string[]; // 8-10 filmable nouns/settings the ranker should prefer
  avoid: string[]; // 4-6 concepts to down-rank
  direction: string; // <= 20 English words: mood/tone, lighting, color, energy
  fallbackQueries: string[]; // 5 plain 2-4 word Pexels phrases
};

export type StylePack = {
  id: StylePackId;
  version: "v1.0.0";
  status: StylePackStatus;
  thaiLabel: string;
  tagline: string; // <= 40 Thai code points, shown on the card
  visualFormatId: ActiveVisualFormatId;
  treatmentPresetId: StylePackTreatmentId;
  palette: [string, string, string];
  personality: string; // Thai, <= 60 code points, feeds visual.personality
  stockMood: StockMood;
  pacing: PacingLevel;
  musicMood: MusicMood;
  subtitle: SubtitleStylePresetConfig;
  scriptTone: string; // Thai, feeds script.tone
};

export const STYLE_PACKS: readonly StylePack[] = [
  {
    id: "thai-ghost",
    version: "v1.0.0",
    status: "active",
    thaiLabel: "หนังผีไทย",
    tagline: "มืด หลอน ค่อย ๆ กดดัน เหมือนหนังผีไทย",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "thai-supernatural-horror",
    palette: ["#0B0F1A", "#7C1D2B", "#C9A24C"],
    personality: "มืด เย็น หลอน แสงน้อย เงาเข้ม",
    stockMood: {
      queryToken: "night",
      positive: ["night", "moonlight", "abandoned house", "candle light", "fog", "shadow", "old temple", "forest at night", "rain at night", "flickering light"],
      avoid: ["bright daylight", "office", "smiling people", "product", "city skyline", "cartoon"],
      direction: "eerie nocturnal Thai horror, dim moonlight and candle glow, desaturated cold tones, slow dread",
      fallbackQueries: ["dark forest night", "old wooden house night", "candle in dark room", "fog at night", "empty corridor dim light"],
    },
    pacing: "normal",
    musicMood: "ominous",
    subtitle: { preset: "bold-shadow", effect: "fade", cardLen: "3", fontFamily: "Kanit", bold: true, fontWeight: 900, fontSize: 64, textColor: "#FFFFFF", accentColor: "#E11D48", shadow: true, outline: false, outlineSize: 2, verticalPos: 78 },
    scriptTone: "เล่าช้า ๆ สร้างความกดดันทีละนิด ใช้รายละเอียดที่รู้สึกได้ ไม่เฉลยเร็ว",
  },
  {
    id: "thai-history",
    version: "v1.0.0",
    status: "active",
    thaiLabel: "ประวัติศาสตร์ย้อนยุค",
    tagline: "ย้อนยุค อบอุ่น เล่าเรื่องเก่าให้มีชีวิต",
    visualFormatId: "retro-story",
    treatmentPresetId: "thai-history-period-storytelling",
    palette: ["#3B2A1A", "#C8A86B", "#F1E6D0"],
    personality: "โทนซีเปีย กระดาษเก่า แสงอุ่น ภาพย้อนยุค",
    stockMood: {
      queryToken: "vintage",
      positive: ["old temple", "ruins", "ancient", "archive", "monument", "mural", "palace", "faded photograph"],
      avoid: ["smartphone", "neon", "modern office", "plastic products"],
      direction: "warm sepia historical Thai storytelling, aged paper texture, muted gold and cream tones, dignified unhurried pace",
      fallbackQueries: ["old thai temple", "ancient stone ruins", "vintage sepia photo", "old palace hallway", "faded mural wall"],
    },
    pacing: "normal",
    musicMood: "serious",
    subtitle: { preset: "retro", effect: "fade", cardLen: "4", fontFamily: "Sarabun", bold: false, fontWeight: 600, fontSize: 60, textColor: "#F5E6C8", accentColor: "#D4A017", shadow: true, outline: false, outlineSize: 2, verticalPos: 78 },
    scriptTone: "เล่าอย่างผู้รู้ ลำดับเหตุการณ์ชัด ใส่ปี สถานที่ และบุคคลจริง ไม่ปรุงแต่งเกินหลักฐาน",
  },
  {
    id: "life-drama",
    version: "v1.0.0",
    status: "active",
    thaiLabel: "ดราม่าชีวิตจริง",
    tagline: "อบอุ่น จริงใจ เรื่องคนธรรมดาที่กระทบใจ",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "thai-human-drama",
    palette: ["#1F2933", "#B45309", "#E7D8C4"],
    personality: "แสงธรรมชาติ โทนอุ่น ใกล้ชิด สมจริง",
    stockMood: {
      queryToken: "cinematic",
      positive: ["family", "home", "rain window", "hands", "hospital corridor", "village", "evening light", "family dinner table"],
      avoid: ["corporate", "luxury", "cartoon", "neon nightclub"],
      direction: "intimate warm Thai domestic drama, natural window light, soft amber tones, gentle emotional pacing",
      fallbackQueries: ["rain on window", "family at home", "hospital corridor light", "village evening light", "hands holding hands"],
    },
    pacing: "normal",
    musicMood: "emotional",
    subtitle: { preset: "shadow", effect: "fade", cardLen: "4", fontFamily: "Kanit", bold: false, fontWeight: 600, fontSize: 60, textColor: "#FFFFFF", accentColor: "#FDE68A", shadow: true, outline: false, outlineSize: 2, verticalPos: 78 },
    scriptTone: "เล่าจากมุมมองคนจริง ใช้ประโยคสั้น ใส่ความรู้สึก ไม่ตัดสินตัวละคร",
  },
  {
    id: "finance-clear",
    version: "v1.0.0",
    status: "active",
    thaiLabel: "ธุรกิจ-การเงินชัดเจน",
    tagline: "สะอาด ชัด ตัวเลขเข้าใจได้ในครั้งเดียว",
    visualFormatId: "clear-infographic",
    treatmentPresetId: "expert-clarity",
    palette: ["#0F172A", "#2563EB", "#F8FAFC"],
    personality: "สะอาด ทันสมัย น้ำเงินเข้ม ตัวเลขเด่น",
    stockMood: {
      queryToken: "clean",
      positive: ["chart", "coins", "laptop", "calculator", "desk", "city", "documents", "stock ticker board"],
      avoid: ["horror", "dark", "party", "cartoon"],
      direction: "clean modern financial clarity, crisp studio light, deep blue and white tones, confident brisk energy",
      fallbackQueries: ["stock market chart", "laptop and calculator", "city office desk", "coins and documents", "business city skyline"],
    },
    pacing: "fast",
    musicMood: "upbeat",
    subtitle: { preset: "box", effect: "pop", cardLen: "3", fontFamily: "Kanit", bold: true, fontWeight: 900, fontSize: 64, textColor: "#FFFFFF", accentColor: "#FACC15", shadow: false, outline: false, outlineSize: 2, verticalPos: 76 },
    scriptTone: "อธิบายตรงประเด็น ตัวเลขชัด ยกตัวอย่างใกล้ตัว สรุปเป็นข้อ",
  },
  {
    id: "news-fast",
    version: "v1.0.0",
    status: "active",
    thaiLabel: "ข่าวสรุปเร็ว",
    tagline: "เร็ว กระชับ สรุปประเด็นแบบข่าวด่วน",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "investigative-news-crime",
    palette: ["#111827", "#DC2626", "#E5E7EB"],
    personality: "คอนทราสต์สูง แดงเข้ม กระชับ เร่งด่วน",
    stockMood: {
      queryToken: "news",
      positive: ["newsroom", "city street", "press", "documents", "courthouse", "aerial city", "microphone", "breaking news desk"],
      avoid: ["cartoon", "fantasy", "product", "romantic scene"],
      direction: "urgent investigative newsroom energy, high contrast lighting, deep red and white tones, fast tense pacing",
      fallbackQueries: ["newsroom press desk", "city street press", "courthouse steps", "aerial city view", "breaking news studio"],
    },
    pacing: "fast",
    musicMood: "tense",
    subtitle: { preset: "news", effect: "quick", cardLen: "2", fontFamily: "Kanit", bold: true, fontWeight: 900, fontSize: 68, textColor: "#FFFFFF", accentColor: "#DC2626", shadow: false, outline: false, outlineSize: 2, verticalPos: 76 },
    scriptTone: "เปิดด้วยประเด็นสำคัญทันที ประโยคสั้น ข้อเท็จจริงนำ ไม่ใส่ความเห็นเกิน",
  },
  {
    id: "health-simple",
    version: "v1.0.0",
    status: "active",
    thaiLabel: "สุขภาพเข้าใจง่าย",
    tagline: "สว่าง สบายตา เรื่องสุขภาพที่เข้าใจง่าย",
    visualFormatId: "simple-editorial-story",
    treatmentPresetId: "expert-clarity",
    palette: ["#ECFDF5", "#10B981", "#1F2937"],
    personality: "สว่าง สะอาด เขียวสดชื่น เป็นมิตร",
    stockMood: {
      queryToken: "healthy",
      positive: ["fresh food", "exercise", "clinic", "sleep", "water", "vegetables", "morning jog", "doctor consultation"],
      avoid: ["horror", "alcohol", "graphic surgery", "junk food"],
      direction: "bright fresh wellness mood, soft natural daylight, clean green and white tones, calm friendly energy",
      fallbackQueries: ["fresh vegetables table", "morning jogging outdoors", "clinic waiting room", "glass of water", "healthy meal prep"],
    },
    pacing: "normal",
    musicMood: "calm",
    subtitle: { preset: "box-rounded", effect: "pop", cardLen: "3", fontFamily: "Prompt", bold: false, fontWeight: 600, fontSize: 60, textColor: "#FFFFFF", accentColor: "#34D399", shadow: false, outline: false, outlineSize: 2, verticalPos: 78 },
    scriptTone: "อธิบายเป็นขั้นตอน ใช้คำง่าย ใส่ข้อควรระวัง ไม่ชี้นำเกินหลักฐาน",
  },
  {
    id: "premium-product",
    version: "v1.0.0",
    status: "active",
    thaiLabel: "โฆษณาสินค้าพรีเมียม",
    tagline: "หรู นิ่ง ใส่ใจรายละเอียดแบบพรีเมียม",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "premium-product-lifestyle",
    palette: ["#111111", "#D4A017", "#F5F5F4"],
    personality: "ดำ-ทอง แสงนุ่ม พื้นผิวหรู เนิบช้า",
    stockMood: {
      queryToken: "luxury",
      positive: ["product close-up", "studio light", "marble", "unboxing", "minimal interior", "leather texture", "gold detail", "soft reflection"],
      avoid: ["crowd", "messy", "cartoon", "bright daylight outdoor"],
      direction: "luxurious restrained product mood, soft studio light, black and gold tones, slow deliberate elegance",
      fallbackQueries: ["product studio light", "marble surface closeup", "luxury unboxing", "gold detail closeup", "minimal luxury interior"],
    },
    pacing: "slow",
    musicMood: "lounge",
    subtitle: { preset: "plain", effect: "fade", cardLen: "sentence", fontFamily: "Prompt", bold: false, fontWeight: 400, fontSize: 52, textColor: "#FFFFFF", accentColor: "#D4A017", shadow: true, outline: false, outlineSize: 2, verticalPos: 80 },
    scriptTone: "เล่าช้าและมั่นใจ เน้นคุณค่าและรายละเอียด ไม่ขายดุดัน",
  },
  {
    id: "dark-story",
    version: "v1.0.0",
    status: "pending-benchmark",
    thaiLabel: "คดีดัง / เรื่องเล่าดาร์ก",
    tagline: "ดิบ มืด ตึงเครียด แบบเรื่องเล่าคดีดัง",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "dark-story-true-crime",
    palette: ["#0A0A0A", "#6B7280", "#B91C1C"],
    personality: "มืด ดิบ เทาเข้ม แดงเลือดเป็นจุดเน้น",
    stockMood: {
      queryToken: "dark",
      positive: ["dim room", "rain street", "police tape", "evidence", "old photo", "corridor", "CCTV", "silhouette"],
      avoid: ["bright", "smiling", "product", "cartoon"],
      direction: "raw grim true-crime mood, dim harsh lighting, dark gray and blood-red tones, tense unsettling energy",
      fallbackQueries: ["rainy city street", "police tape scene", "dim empty corridor", "old case file", "silhouette in doorway"],
    },
    pacing: "normal",
    musicMood: "ominous",
    subtitle: { preset: "bold-shadow", effect: "quick", cardLen: "2", fontFamily: "Kanit", bold: true, fontWeight: 900, fontSize: 66, textColor: "#FFFFFF", accentColor: "#B91C1C", shadow: true, outline: false, outlineSize: 2, verticalPos: 78 },
    scriptTone: "เล่าเป็นไทม์ไลน์ ค่อย ๆ เปิดเงื่อนงำ ใช้ข้อเท็จจริง ไม่ตัดสินก่อนจบ",
  },
  {
    id: "politics",
    version: "v1.0.0",
    status: "pending-benchmark",
    thaiLabel: "เจาะประเด็นการเมือง",
    tagline: "จริงจัง เป็นกลาง เจาะประเด็นให้เห็นภาพ",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "political-commentary",
    palette: ["#1E293B", "#2563EB", "#F1F5F9"],
    personality: "น้ำเงินเข้ม เรียบ จริงจัง เป็นทางการ",
    stockMood: {
      queryToken: "editorial",
      positive: ["parliament", "flag", "podium", "city hall", "documents", "newspaper", "ballot", "rally wide shot"],
      avoid: ["cartoon", "horror", "celebrity faces", "product close-up"],
      direction: "serious formal editorial mood, flat even lighting, deep navy tones, measured deliberate pacing",
      fallbackQueries: ["parliament building exterior", "podium press conference", "city hall steps", "newspaper on desk", "rally wide shot"],
    },
    pacing: "normal",
    musicMood: "serious",
    subtitle: { preset: "news", effect: "quick", cardLen: "3", fontFamily: "Sarabun", bold: true, fontWeight: 900, fontSize: 62, textColor: "#FFFFFF", accentColor: "#2563EB", shadow: false, outline: false, outlineSize: 2, verticalPos: 76 },
    scriptTone: "วางบริบทก่อน ให้ทั้งสองฝั่ง ใช้หลักฐาน สรุปผลกระทบต่อคนดู",
  },
  {
    id: "mystery",
    version: "v1.0.0",
    status: "pending-benchmark",
    thaiLabel: "ลึกลับ / ทฤษฎีสมคบคิด",
    tagline: "ลึกลับ ชวนสงสัย ค่อย ๆ เปิดปม",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "mystery-unexplained",
    palette: ["#061A1F", "#14B8A6", "#C89B3C"],
    personality: "เขียวน้ำเงินเข้ม แสงหมอก ทองหม่น ลึกลับ",
    stockMood: {
      queryToken: "mysterious",
      positive: ["fog", "night sky", "old map", "symbols", "ruins", "library", "files", "lantern"],
      avoid: ["bright office", "product", "smiling", "cartoon"],
      direction: "eerie foggy mysterious mood, dim diffused lighting, teal-green and muted gold tones, slow unsettled pacing",
      fallbackQueries: ["foggy night forest", "old paper map", "library archive shelves", "lantern in fog", "ancient ruins night"],
    },
    pacing: "slow",
    musicMood: "eerie",
    subtitle: { preset: "glow", effect: "fade", cardLen: "3", fontFamily: "Kanit", bold: false, fontWeight: 600, fontSize: 62, textColor: "#E5E7EB", accentColor: "#14B8A6", shadow: true, outline: false, outlineSize: 2, verticalPos: 78 },
    scriptTone: "ตั้งคำถามนำ เล่าหลักฐานทีละชิ้น ทิ้งปมให้คิดต่อ ไม่ฟันธง",
  },
  {
    id: "dharma",
    version: "v1.0.0",
    status: "pending-benchmark",
    thaiLabel: "นิทานธรรมะ",
    tagline: "สงบ อบอุ่น เรื่องเล่าธรรมะที่เข้าใจง่าย",
    visualFormatId: "simple-editorial-story",
    treatmentPresetId: "dharma-storytelling",
    palette: ["#7C2D12", "#D4A017", "#FFF7E6"],
    personality: "ทอง-น้ำตาลแดง แสงอุ่น สงบ เรียบง่าย",
    stockMood: {
      queryToken: "temple",
      positive: ["temple", "lotus", "candle", "golden light", "Buddha statue", "rice field", "morning mist", "offering"],
      avoid: ["horror", "nightlife", "violence", "product close-up"],
      direction: "calm warm dharma storytelling mood, soft golden temple light, gold and warm brown tones, gentle serene pace",
      fallbackQueries: ["buddha statue temple", "lotus flower candle", "rice field morning", "temple golden light", "monk offering ceremony"],
    },
    pacing: "slow",
    musicMood: "traditional",
    subtitle: { preset: "plain", effect: "fade", cardLen: "sentence", fontFamily: "Sarabun", bold: false, fontWeight: 600, fontSize: 58, textColor: "#FFF7E6", accentColor: "#D4A017", shadow: true, outline: false, outlineSize: 2, verticalPos: 50 },
    scriptTone: "เล่าอย่างสงบ ประโยคเรียบง่าย ปิดด้วยข้อคิดหนึ่งข้อ ไม่เทศนายาว",
  },
  {
    id: "motivation",
    version: "v1.0.0",
    status: "pending-benchmark",
    thaiLabel: "โมทิเวชันซีเนมาติก",
    tagline: "ทรงพลัง ซีเนมาติก ปลุกใจให้ลุกขึ้นทำ",
    visualFormatId: "cinematic-realism",
    treatmentPresetId: "stoic-motivation",
    palette: ["#0B1B2B", "#1D4ED8", "#E0B04A"],
    personality: "น้ำเงินเข้ม ทองอำพัน ยิ่งใหญ่ ซีเนมาติก",
    stockMood: {
      queryToken: "cinematic",
      positive: ["sunrise mountain", "ocean", "lone silhouette", "road", "city dawn", "storm clouds", "stars", "mountain summit"],
      avoid: ["cartoon", "product", "office meeting", "horror"],
      direction: "epic cinematic motivational mood, dramatic dawn lighting, deep navy and amber tones, building powerful energy",
      fallbackQueries: ["sunrise over mountain", "ocean waves sunrise", "lone figure silhouette", "empty road dawn", "storm clouds sky"],
    },
    pacing: "slow",
    musicMood: "epic",
    subtitle: { preset: "bold-shadow", effect: "fade", cardLen: "4", fontFamily: "Kanit", bold: true, fontWeight: 900, fontSize: 64, textColor: "#FFFFFF", accentColor: "#FFFFFF", shadow: true, outline: false, outlineSize: 2, verticalPos: 78 },
    scriptTone: "พูดตรงกับคนดู ประโยคสั้นหนักแน่น ค่อย ๆ ยกระดับ จบด้วยคำสั่งให้ลงมือ",
  },
] as const;

const STYLE_PACK_BY_ID = new Map(STYLE_PACKS.map((pack) => [pack.id, pack]));

export function stylePack(id: StylePackId): StylePack {
  const pack = STYLE_PACK_BY_ID.get(id);
  if (!pack) throw new Error(`Unknown Style Pack: ${id}`);
  return pack;
}

export function activeStylePacks(): readonly StylePack[] {
  return STYLE_PACKS.filter((pack) => pack.status === "active");
}

export function isStylePackId(value: unknown): value is StylePackId {
  return typeof value === "string" && (STYLE_PACK_IDS as readonly string[]).includes(value);
}

/** First ACTIVE pack using this Treatment; pending packs are never recommended. */
export function stylePackForTreatment(treatmentPresetId: string): StylePack | null {
  return STYLE_PACKS.find((pack) => pack.status === "active" && pack.treatmentPresetId === treatmentPresetId) ?? null;
}

export const PACING_CADENCE_MULTIPLIER: Record<PacingLevel, number> = {
  slow: 1.6,
  normal: 1,
  fast: 0.7,
};

export const PACING_MIN_HOLD_SEC: Record<PacingLevel, number> = {
  slow: 6,
  normal: 4,
  fast: 2.5,
};
