export type ContentProfile =
  | "tutorial_product"
  | "ai_tech"
  | "news_crime"
  | "business_finance"
  | "health_medical"
  | "family_lifestyle"
  | "education"
  | "travel_food"
  | "motivation_abstract"
  | "general";

const CONTENT_PROFILES: ContentProfile[] = [
  "tutorial_product",
  "ai_tech",
  "news_crime",
  "business_finance",
  "health_medical",
  "family_lifestyle",
  "education",
  "travel_food",
  "motivation_abstract",
  "general",
];

const PROFILE_DETECTION_TERMS: Record<ContentProfile, string[]> = {
  news_crime: [
    "ข่าว", "ดราม่า", "คดี", "อาชญากรรม", "ตำรวจ", "ศาล", "จับ", "สารภาพ", "หลักฐาน",
    "ผู้ต้องหา", "เหยื่อ", "โกง", "ขโมย", "ปล้น", "ฆ่า", "บาดเจ็บ", "เสียชีวิต", "ไฟไหม้",
    "ลอตเตอรี่", "หวย", "รางวัล", "เงินสด", "โรงพัก", "crime", "police", "court", "evidence",
    "scam", "theft", "murder", "lottery", "arrest", "suspect", "investigation",
  ],
  tutorial_product: [
    "สอน", "วิธี", "ทำยังไง", "ขั้นตอน", "ใช้งาน", "ตั้งค่า", "แอป", "โปรแกรม", "ตัดต่อ",
    "คอนเทนต์", "คลิป", "กล้อง", "ไมค์", "tutorial", "how to", "step", "editing", "app",
    "software", "screen recording", "camera", "workflow", "avatar",
  ],
  ai_tech: [
    "ai", "เอไอ", "ปัญญาประดิษฐ์", "โมเดล", "llm", "chatgpt", "automation", "เทคโนโลยี",
    "ระบบ", "ข้อมูล", "ดิจิทัล", "เซิร์ฟเวอร์", "robot", "neural", "data", "developer",
    "machine learning", "startup",
  ],
  business_finance: [
    "ธุรกิจ", "การตลาด", "ยอดขาย", "รายได้", "ลงทุน", "ตลาด", "กำไร", "ลูกค้า", "หุ้น",
    "บัญชี", "ภาษี", "business", "sales", "profit", "market", "invest", "finance", "customer",
  ],
  health_medical: [
    "สุขภาพ", "หมอ", "แพทย์", "โรงพยาบาล", "ยา", "ผู้ป่วย", "ออกกำลัง", "อาหารเสริม",
    "health", "doctor", "medical", "hospital", "patient", "fitness", "medicine",
  ],
  family_lifestyle: [
    "บ้าน", "ครอบครัว", "เด็ก", "พ่อแม่", "คู่รัก", "ชีวิต", "ไลฟ์สไตล์", "family", "home",
    "child", "parent", "lifestyle", "relationship",
  ],
  education: [
    "เรียน", "ศึกษา", "โรงเรียน", "มหาวิทยาลัย", "ครู", "นักเรียน", "คอร์ส", "ความรู้",
    "education", "student", "learn", "classroom", "teacher", "course",
  ],
  travel_food: [
    "เดินทาง", "เที่ยว", "โรงแรม", "รถ", "ถนน", "เมือง", "อาหาร", "กิน", "ร้าน", "ครัว",
    "กาแฟ", "travel", "hotel", "restaurant", "food", "coffee", "kitchen", "city",
  ],
  motivation_abstract: [
    "สำเร็จ", "เติบโต", "เป้าหมาย", "แรงบันดาลใจ", "ความหวัง", "ชีวิตดี", "mindset",
    "success", "growth", "goal", "motivation", "inspiration", "hope",
  ],
  general: [],
};

export const PROFILE_FALLBACK_QUERIES: Record<ContentProfile, string[]> = {
  news_crime: [
    "police station exterior",
    "police lights night",
    "official document close up",
    "evidence bag close up",
    "hands counting cash",
    "worried elderly woman",
    "courtroom empty",
    "detective paperwork desk",
    "lottery ticket close up",
    "burning paper close up",
    "hand holding money",
    "serious interview room",
  ],
  tutorial_product: [
    "video editing timeline",
    "creator filming studio",
    "smartphone app close up",
    "laptop workspace",
    "camera gimbal close up",
    "screen recording software",
    "hands typing laptop",
    "microphone recording desk",
    "creator desk setup",
  ],
  ai_tech: [
    "artificial intelligence interface",
    "humanoid robot close up",
    "server room lights",
    "software developer laptop",
    "neural network animation",
    "data dashboard screen",
    "automation control room",
  ],
  business_finance: [
    "business meeting room",
    "hands counting money",
    "financial chart screen",
    "office presentation",
    "customer service desk",
    "startup team laptop",
    "contract signing close up",
  ],
  health_medical: [
    "doctor consultation",
    "hospital corridor",
    "medical document close up",
    "patient talking doctor",
    "fitness training",
    "healthy food preparation",
    "medicine bottle close up",
  ],
  family_lifestyle: [
    "family at home",
    "parent child living room",
    "woman thinking window",
    "couple conversation home",
    "children playing indoors",
    "cozy living room",
    "daily routine morning",
  ],
  education: [
    "student studying laptop",
    "classroom learning",
    "teacher writing board",
    "online course laptop",
    "library study desk",
    "notebook notes close up",
    "seminar audience",
  ],
  travel_food: [
    "city street walking",
    "travel suitcase hotel",
    "restaurant kitchen",
    "coffee shop counter",
    "food preparation close up",
    "car driving road",
    "street food market",
  ],
  motivation_abstract: [
    "person sunrise silhouette",
    "runner morning road",
    "plant sprouting soil",
    "team celebration office",
    "mountain sunrise view",
    "person writing goals",
    "bright city morning",
  ],
  general: [
    "hands using smartphone",
    "person reading document",
    "people walking city",
    "office desk close up",
    "person thinking window",
    "team meeting room",
    "hands typing laptop",
    "notebook pen close up",
  ],
};

const PROFILE_POSITIVE_TERMS: Record<ContentProfile, string[]> = {
  news_crime: [
    "police", "court", "law", "legal", "document", "evidence", "detective", "investigation",
    "money", "cash", "lottery", "ticket", "worried", "serious", "arrest", "crime", "siren",
    "fire", "paper", "interview",
  ],
  tutorial_product: [
    "editing", "timeline", "creator", "studio", "camera", "gimbal", "microphone", "laptop",
    "smartphone", "software", "screen", "app", "recording", "desk", "tutorial",
  ],
  ai_tech: [
    "ai", "artificial", "intelligence", "robot", "server", "software", "developer", "data",
    "dashboard", "network", "automation", "technology", "code",
  ],
  business_finance: [
    "business", "office", "meeting", "money", "finance", "chart", "presentation", "contract",
    "customer", "startup", "sales", "market",
  ],
  health_medical: [
    "doctor", "medical", "hospital", "patient", "health", "fitness", "medicine", "clinic",
    "consultation",
  ],
  family_lifestyle: [
    "family", "home", "parent", "child", "children", "couple", "living", "room", "routine",
    "lifestyle",
  ],
  education: [
    "student", "study", "studying", "teacher", "classroom", "learning", "course", "library",
    "seminar", "notebook",
  ],
  travel_food: [
    "travel", "hotel", "restaurant", "food", "coffee", "kitchen", "city", "street", "road",
    "market", "suitcase",
  ],
  motivation_abstract: [
    "sunrise", "runner", "goal", "growth", "success", "celebration", "morning", "inspiration",
    "plant", "mountain",
  ],
  general: [],
};

const PROFILE_REJECT_TERMS: Record<ContentProfile, string[]> = {
  news_crime: [
    "goat", "sheep", "cow", "animal", "grass", "flower", "bee", "insect", "mountain", "lake",
    "boat", "beach", "guitar", "music", "concert", "cigarette", "smoking", "kitchen", "food",
    "robot", "software", "coding", "computer", "server", "sunset", "nature", "forest", "garden",
  ],
  tutorial_product: [
    "goat", "sheep", "cow", "flower", "bee", "insect", "mountain", "lake", "beach", "court",
    "police", "hospital", "restaurant", "food",
  ],
  ai_tech: ["goat", "sheep", "cow", "flower", "bee", "insect", "beach", "restaurant", "food"],
  business_finance: ["goat", "sheep", "cow", "bee", "insect", "beach", "police", "hospital"],
  health_medical: ["goat", "sheep", "cow", "bee", "insect", "police", "court", "server"],
  family_lifestyle: ["server", "robot", "police", "court", "surgery", "factory"],
  education: ["goat", "sheep", "cow", "bee", "insect", "police", "court", "surgery"],
  travel_food: ["server", "robot", "police", "court", "surgery"],
  motivation_abstract: ["police", "court", "surgery", "server", "robot"],
  general: [],
};

const PROFILE_PROMPT_LABELS: Record<ContentProfile, string> = {
  news_crime: "news/crime/legal drama",
  tutorial_product: "tutorial/product/software workflow",
  ai_tech: "AI/technology/startup",
  business_finance: "business/finance",
  health_medical: "health/medical",
  family_lifestyle: "family/lifestyle",
  education: "education/learning",
  travel_food: "travel/food",
  motivation_abstract: "motivation/abstract lifestyle",
  general: "general documentary",
};

const PROFILE_PROMPT_RULES: Record<ContentProfile, string> = {
  news_crime: "Use neutral documentary/legal/crime-news reenactment visuals. Prefer police, documents, money, evidence, worried people, courtrooms, and official locations. Avoid animals, nature, travel, food, and unrelated tech unless a subtitle directly says so.",
  tutorial_product: "Use practical creator-workflow visuals. Prefer editing timelines, laptop or phone app usage, cameras, microphones, studio desks, and software screens. Avoid random lifestyle, nature, crime, and medical visuals.",
  ai_tech: "Use technology documentary visuals. Prefer AI interfaces, server rooms, developers, robots, dashboards, and automation. Avoid random animals, travel, food, and unrelated lifestyle footage.",
  business_finance: "Use business documentary visuals. Prefer meetings, office work, contracts, money, charts, customers, and startup teams. Avoid random nature, animals, and unrelated crime or medical footage.",
  health_medical: "Use clean health and medical visuals. Prefer doctors, hospitals, patient consultations, medicines, fitness, and healthy lifestyle. Avoid crime, random technology, and unrelated travel visuals.",
  family_lifestyle: "Use warm human lifestyle visuals. Prefer home, family, relationships, daily routines, and thoughtful people. Avoid crime, servers, factories, and unrelated medical visuals.",
  education: "Use learning and training visuals. Prefer students, classrooms, teachers, courses, notebooks, libraries, and seminars. Avoid random nature, crime, and medical footage.",
  travel_food: "Use travel, city, and food visuals. Prefer streets, hotels, restaurants, coffee shops, kitchens, roads, and markets. Avoid unrelated crime, medical, and server-room footage.",
  motivation_abstract: "Use aspirational lifestyle visuals. Prefer sunrise, goals, growth, teamwork, runners, and bright optimistic city or nature scenes. Avoid crime, medical, and random technology footage.",
  general: "Use neutral documentary visuals. Prefer people, documents, phones, laptops, offices, and city life over unrelated animals or scenery.",
};

export function normalizeContentProfile(raw: unknown): ContentProfile {
  if (typeof raw !== "string") return "general";
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return CONTENT_PROFILES.includes(value as ContentProfile) ? value as ContentProfile : "general";
}

function includesProfileDetectionTerm(text: string, term: string): boolean {
  const cleanTerm = term.trim().toLowerCase();
  if (!cleanTerm) return false;
  if (/^[a-z0-9\s-]+$/.test(cleanTerm)) {
    return new RegExp(`(^|[^a-z0-9])${cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);
  }
  return text.includes(cleanTerm);
}

export function detectContentProfile(text: string): ContentProfile {
  const haystack = (text ?? "").toLowerCase();
  if (!haystack.trim()) return "general";

  let best: ContentProfile = "general";
  let bestScore = 0;

  for (const profile of CONTENT_PROFILES) {
    if (profile === "general") continue;
    let score = 0;
    for (const term of PROFILE_DETECTION_TERMS[profile]) {
      if (includesProfileDetectionTerm(haystack, term)) score++;
    }
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : "general";
}

export function contentProfilePromptBlock(profile: ContentProfile): string {
  const normalized = normalizeContentProfile(profile);
  return `CONTENT PROFILE: ${normalized} (${PROFILE_PROMPT_LABELS[normalized]})
${PROFILE_PROMPT_RULES[normalized]}`;
}

export function fallbackQueriesForProfile(profile: ContentProfile): string[] {
  return PROFILE_FALLBACK_QUERIES[normalizeContentProfile(profile)];
}

export function positiveTermsForProfile(profile: ContentProfile): string[] {
  return PROFILE_POSITIVE_TERMS[normalizeContentProfile(profile)];
}

export function rejectTermsForProfile(profile: ContentProfile): string[] {
  return PROFILE_REJECT_TERMS[normalizeContentProfile(profile)];
}
