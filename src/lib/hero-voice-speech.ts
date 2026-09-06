import { splitScriptForTts } from "@/lib/tts-timing";
import pronunciationEntries from "../../data/hero-voice/thai-pronunciations.json";

const THAI_DIGIT_WORDS = [
  "ศูนย์",
  "หนึ่ง",
  "สอง",
  "สาม",
  "สี่",
  "ห้า",
  "หก",
  "เจ็ด",
  "แปด",
  "เก้า",
] as const;

const THAI_PLACE_WORDS = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"] as const;
const THAI_MONTH_WORDS = [
  "",
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
] as const;
const THAI_WORD_SEGMENTER = new Intl.Segmenter("th", { granularity: "word" });
const THAI_ACCENT_PRONUNCIATIONS = [...pronunciationEntries]
  .sort((left, right) => right.match.length - left.match.length);
const THAI_ENGLISH_LETTER_NAMES: Record<string, string> = {
  A: "เอ", B: "บี", C: "ซี", D: "ดี", E: "อี", F: "เอฟ", G: "จี",
  H: "เอช", I: "ไอ", J: "เจ", K: "เค", L: "แอล", M: "เอ็ม", N: "เอ็น",
  O: "โอ", P: "พี", Q: "คิว", R: "อาร์", S: "เอส", T: "ที", U: "ยู",
  V: "วี", W: "ดับเบิลยู", X: "เอ็กซ์", Y: "วาย", Z: "แซด",
};
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const NUMBER_SOURCE = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
const UNSIGNED_CURRENCY_NUMBER_SOURCE = String.raw`\d[\d,]*(?:\.\d{1,2})?`;
const CURRENCY_NUMBER_SOURCE = String.raw`[+-]?\d[\d,]*(?:\.\d{1,2})?`;
const DIGIT_SEQUENCE_CONTEXT_RE = /(เบอร์(?:โทร(?:ศัพท์)?)?|โทรศัพท์|OTP|PIN|รหัส(?:ผ่าน|ยืนยัน|ไปรษณีย์|สินค้า)?|เลขบัญชี|เลขบัตร(?:ประชาชน|เครดิต)?|เลขประจำตัว)(\s*)(\d(?:[\d -]*\d)?)/giu;
const THAI_SPEECH_UNITS = [
  { written: "กม./ชม.", spoken: "กิโลเมตรต่อชั่วโมง" },
  { written: "km/h", spoken: "กิโลเมตรต่อชั่วโมง" },
  { written: "m/s", spoken: "เมตรต่อวินาที" },
  { written: "GHz", spoken: "กิกะเฮิรตซ์" },
  { written: "MHz", spoken: "เมกะเฮิรตซ์" },
  { written: "kHz", spoken: "กิโลเฮิรตซ์" },
  { written: "°C", spoken: "องศาเซลเซียส" },
  { written: "°F", spoken: "องศาฟาเรนไฮต์" },
  { written: "กก.", spoken: "กิโลกรัม" },
  { written: "กม.", spoken: "กิโลเมตร" },
  { written: "ซม.", spoken: "เซนติเมตร" },
  { written: "มม.", spoken: "มิลลิเมตร" },
  { written: "มล.", spoken: "มิลลิลิตร" },
  { written: "kg", spoken: "กิโลกรัม" },
  { written: "km", spoken: "กิโลเมตร" },
  { written: "cm", spoken: "เซนติเมตร" },
  { written: "mm", spoken: "มิลลิเมตร" },
  { written: "ml", spoken: "มิลลิลิตร" },
  { written: "TB", spoken: "เทราไบต์" },
  { written: "GB", spoken: "กิกะไบต์" },
  { written: "MB", spoken: "เมกะไบต์" },
  { written: "KB", spoken: "กิโลไบต์" },
  { written: "Hz", spoken: "เฮิรตซ์" },
] as const;
const THAI_SPEECH_UNIT_LOOKUP = new Map(
  THAI_SPEECH_UNITS.map((unit) => [unit.written.toLocaleLowerCase("en"), unit.spoken]),
);
const THAI_SPEECH_UNIT_RE = new RegExp(
  `(${NUMBER_SOURCE})\\s*(${THAI_SPEECH_UNITS
    .map((unit) => escapeRegExp(unit.written))
    .join("|")})(?=$|[^\\p{L}\\p{M}\\p{N}])`,
  "giu",
);

export const HERO_VOICE_SPEECH_NORMALIZER_VERSION = "2026-09-07.1";

export type HeroVoiceSpeechRiskCode =
  | "ambiguous_numeric_slash"
  | "email"
  | "unexpanded_currency"
  | "unexpanded_math_symbol"
  | "unexpanded_number"
  | "unexpanded_percent"
  | "unexpanded_repetition"
  | "unreviewed_latin"
  | "url";

export interface HeroVoiceSpeechRisk {
  code: HeroVoiceSpeechRiskCode;
  severity: "block" | "review";
}

export interface HeroVoiceSpeechPreparation {
  speechText: string;
  risks: HeroVoiceSpeechRisk[];
  normalizerVersion: string;
}

function thaiSixDigitGroup(digits: string, hasHigherGroup: boolean): string {
  let result = "";
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[index]);
    if (digit === 0) continue;

    const place = digits.length - index - 1;
    if (place === 0) {
      const hasEarlierValue = hasHigherGroup || /[1-9]/.test(digits.slice(0, index));
      result += digit === 1 && hasEarlierValue ? "เอ็ด" : THAI_DIGIT_WORDS[digit];
      continue;
    }
    if (place === 1) {
      if (digit === 1) result += "สิบ";
      else if (digit === 2) result += "ยี่สิบ";
      else result += `${THAI_DIGIT_WORDS[digit]}สิบ`;
      continue;
    }
    result += `${THAI_DIGIT_WORDS[digit]}${THAI_PLACE_WORDS[place]}`;
  }
  return result;
}

function thaiIntegerWords(rawDigits: string): string {
  const digits = rawDigits.replace(/^0+(?=\d)/, "");
  if (!digits || /^0+$/.test(digits)) return THAI_DIGIT_WORDS[0];

  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 6) {
    groups.unshift(digits.slice(Math.max(0, end - 6), end));
  }

  return groups.map((group, index) => {
    const value = thaiSixDigitGroup(group, index > 0);
    if (!value) return "";
    return `${value}${"ล้าน".repeat(groups.length - index - 1)}`;
  }).join("");
}

function thaiNumberWords(rawNumber: string): string {
  const normalized = rawNumber.replaceAll(",", "");
  const negative = normalized.startsWith("-");
  const positive = normalized.startsWith("+");
  const unsigned = negative || positive ? normalized.slice(1) : normalized;
  const [integerPart, decimalPart] = unsigned.split(".");
  const integerWords = thaiIntegerWords(integerPart);
  const decimalWords = decimalPart
    ? `จุด${[...decimalPart].map((digit) => THAI_DIGIT_WORDS[Number(digit)]).join("")}`
    : "";
  return `${negative ? "ลบ" : positive ? "บวก" : ""}${integerWords}${decimalWords}`;
}

function thaiBahtWords(rawNumber: string): string {
  const normalized = rawNumber.replaceAll(",", "");
  const negative = normalized.startsWith("-");
  const positive = normalized.startsWith("+");
  const unsigned = negative || positive ? normalized.slice(1) : normalized;
  const [integerPart, decimalPart = ""] = unsigned.split(".");
  const satangDigits = decimalPart.padEnd(2, "0").slice(0, 2);
  const integerIsZero = /^0+$/.test(integerPart);
  const satangIsZero = !satangDigits || /^0+$/.test(satangDigits);
  const pieces = [
    integerIsZero ? "" : `${thaiIntegerWords(integerPart)}บาท`,
    satangIsZero ? "" : `${thaiIntegerWords(satangDigits)}สตางค์`,
  ].filter(Boolean);
  const amount = pieces.join("") || "ศูนย์บาท";
  const sign = amount === "ศูนย์บาท" ? "" : negative ? "ลบ" : positive ? "บวก" : "";
  return `${sign}${amount}`;
}

function digitsIndividually(text: string): string {
  return text.replace(/\d/g, (digit) => THAI_DIGIT_WORDS[Number(digit)]);
}

function normalizeThaiDigits(text: string): string {
  return text.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));
}

function thaiTimeWords(rawHour: string, rawMinute: string): string | null {
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  const hourWords = thaiIntegerWords(String(hour));
  return minute === 0
    ? `${hourWords}นาฬิกา`
    : `${hourWords}นาฬิกา${thaiIntegerWords(String(minute))}นาที`;
}

function normalizeThaiSpeechTimes(text: string): string {
  const withTimePrefix = text.replace(
    /เวลา(\s*)(\d{1,2})[:.](\d{2})(?:\s*น\.)?/g,
    (match, spacing: string, hour: string, minute: string) => {
      const spoken = thaiTimeWords(hour, minute);
      return spoken ? `เวลา${spacing}${spoken}` : match;
    },
  );
  return withTimePrefix.replace(
    /(\d{1,2})[:.](\d{2})\s*น\./g,
    (match, hour: string, minute: string) => thaiTimeWords(hour, minute) ?? match,
  );
}

function thaiDateWords(rawDay: string, rawMonth: string, rawYear: string): string | null {
  const day = Number(rawDay);
  const month = Number(rawMonth);
  const year = Number(rawYear);
  if (
    !Number.isInteger(day) || day < 1 || day > 31
    || !Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(year) || rawYear.length !== 4
  ) {
    return null;
  }
  return `วันที่ ${thaiIntegerWords(String(day))} ${THAI_MONTH_WORDS[month]} ปี ${thaiIntegerWords(String(year))}`;
}

function normalizeThaiSpeechDates(text: string): string {
  const prefixedDate = text.replace(
    /วันที่\s+(\d{1,2})[/-](\d{1,2})[/-](\d{4})/g,
    (match, day: string, month: string, year: string) => (
      thaiDateWords(day, month, year) ?? match
    ),
  );
  return prefixedDate.replace(
    /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g,
    (match, year: string, month: string, day: string) => (
      thaiDateWords(day, month, year) ?? match
    ),
  );
}

function normalizeThaiSpeechAbbreviations(text: string): string {
  return text
    .replace(/พ\.ศ\./gu, "พุทธศักราช")
    .replace(/ค\.ศ\./gu, "คริสต์ศักราช");
}

function normalizeThaiSpeechRanges(text: string): string {
  const verbalize = (_match: string, start: string, end: string) => (
    `${thaiNumberWords(start)}ถึง${thaiNumberWords(end)}`
  );
  return text
    .replace(new RegExp(`(${NUMBER_SOURCE})\\s*[–—]\\s*(${NUMBER_SOURCE})`, "g"), verbalize)
    .replace(new RegExp(`(${NUMBER_SOURCE})\\s+-\\s+(${NUMBER_SOURCE})`, "g"), verbalize);
}

function normalizeThaiSpeechCurrencies(text: string): string {
  const prefixedBaht = text.replace(
    new RegExp(`([+-]?)฿\\s*(${UNSIGNED_CURRENCY_NUMBER_SOURCE})(?![\\d.])`, "g"),
    (_match, sign: string, number: string) => thaiBahtWords(`${sign}${number}`),
  );
  const suffixedBaht = prefixedBaht.replace(
    new RegExp(`(?<![\\d.])(${CURRENCY_NUMBER_SOURCE})(?![\\d.])\\s*บาท`, "g"),
    (_match, number: string) => thaiBahtWords(number),
  );
  const currencyNames: Record<string, string> = {
    "$": "ดอลลาร์",
    "€": "ยูโร",
    "£": "ปอนด์",
  };
  return suffixedBaht.replace(
    new RegExp(`([+-]?)([$€£])\\s*(${UNSIGNED_CURRENCY_NUMBER_SOURCE})(?![\\d.])`, "g"),
    (_match, sign: string, symbol: string, number: string) => (
      `${thaiNumberWords(`${sign}${number}`)}${currencyNames[symbol]}`
    ),
  );
}

function normalizeThaiSpeechPercents(text: string): string {
  return text.replace(
    new RegExp(`(${NUMBER_SOURCE})\\s*%`, "g"),
    (_match, number: string) => `${thaiNumberWords(number)}เปอร์เซ็นต์`,
  );
}

function normalizeThaiSpeechUnits(text: string): string {
  return text.replace(
    THAI_SPEECH_UNIT_RE,
    (_match, number: string, unit: string) => (
      `${thaiNumberWords(number)}${THAI_SPEECH_UNIT_LOOKUP.get(unit.toLocaleLowerCase("en"))}`
    ),
  );
}

/** Letter+digit codes such as A07 or MP3 are spelled letter by letter and digit by digit. */
function normalizeThaiSpeechCodes(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{M}\p{N}])([A-Za-z]{1,4})(\d{1,6})(?![\p{L}\p{M}\p{N}])/gu,
    (_match, letters: string, digits: string) => [
      ...[...letters.toUpperCase()].map((letter) => THAI_ENGLISH_LETTER_NAMES[letter]),
      ...[...digits].map((digit) => THAI_DIGIT_WORDS[Number(digit)]),
    ].join(" "),
  );
}

/** Dimensions such as 1920 x 1080 are read as multiplication, not as the letter x. */
function normalizeThaiSpeechDimensions(text: string): string {
  return text.replace(
    new RegExp(`(${NUMBER_SOURCE})\\s*(?<![A-Za-z])[x×X](?![A-Za-z])\\s*(${NUMBER_SOURCE})`, "gu"),
    (_match, left: string, right: string) => `${left} คูณ ${right}`,
  );
}

function normalizeThaiSpeechNumbers(text: string): string {
  return text
    .replace(
      DIGIT_SEQUENCE_CONTEXT_RE,
      (_match, prefix: string, spacing: string, digits: string) => (
        `${prefix}${spacing}${digitsIndividually(digits)}`
      ),
    )
    .replace(/[+-]?\d[\d,]*(?:\.\d+)?/g, (number, offset: number, source: string) => {
      const attachedSign = /^[+-]/.test(number)
        && offset > 0
        && /[\p{L}\p{M}\p{N}]/u.test(source[offset - 1]);
      return attachedSign
        ? `${number[0]}${thaiNumberWords(number.slice(1))}`
        : thaiNumberWords(number);
    });
}

function expandThaiRepetitionMarks(text: string): string {
  let result = "";
  let previousWord = "";

  for (const part of THAI_WORD_SEGMENTER.segment(text)) {
    const markerOnly = part.segment.match(/^ๆ+$/u);
    if (markerOnly) {
      result += previousWord
        ? Array.from({ length: markerOnly[0].length }, () => previousWord).join(" ")
        : part.segment;
      continue;
    }

    const attachedMarker = part.segment.match(/^(.+?)(ๆ+)$/u);
    if (attachedMarker) {
      const [, word, markers] = attachedMarker;
      result += Array.from({ length: markers.length + 1 }, () => word).join(" ");
      previousWord = word;
      continue;
    }

    result += part.segment;
    if (part.isWordLike) previousWord = part.segment;
  }

  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reviewed English→Thai readings (data/hero-voice/thai-pronunciations.json), longest match first. */
function applyThaiPronunciationDictionary(text: string): string {
  return THAI_ACCENT_PRONUNCIATIONS.reduce((result, entry) => {
    const phrase = escapeRegExp(entry.match).replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`(^|[^A-Za-z])${phrase}(?=$|[^A-Za-z])`, "giu");
    return result.replace(pattern, (_match, prefix: string) => `${prefix}${entry.spoken}`);
  }, text);
}

/** Acronyms with no reviewed reading are spelled with Thai letter names. */
function spellUnlistedAcronyms(text: string): string {
  return text.replace(/\b[A-Z]{2,6}\b/g, (acronym) => (
    [...acronym].map((letter) => THAI_ENGLISH_LETTER_NAMES[letter]).join(" ")
  ));
}

function speechRisks(displayText: string, speechText: string): HeroVoiceSpeechRisk[] {
  const risks = new Map<HeroVoiceSpeechRiskCode, HeroVoiceSpeechRisk["severity"]>();
  const add = (code: HeroVoiceSpeechRiskCode, severity: HeroVoiceSpeechRisk["severity"]) => {
    risks.set(code, severity);
  };
  const asciiDisplayText = normalizeThaiDigits(displayText);
  const displayTextWithoutSupportedDates = asciiDisplayText.replace(
    /วันที่\s+\d{1,2}[/-]\d{1,2}[/-]\d{4}/g,
    "",
  );

  if (/[%‰]/u.test(speechText)) add("unexpanded_percent", "block");
  if (/[0-9๐-๙]/u.test(speechText)) add("unexpanded_number", "block");
  if (/ๆ/u.test(speechText)) add("unexpanded_repetition", "block");
  if (/[฿$€£¥]/u.test(speechText)) add("unexpanded_currency", "block");
  if (/[+×=<>]/u.test(speechText)) add("unexpanded_math_symbol", "block");
  if (/\d\s*\/\s*\d/u.test(displayTextWithoutSupportedDates)) {
    add("ambiguous_numeric_slash", "block");
  }
  if (/\b(?:https?:\/\/|www\.)/iu.test(displayText)) add("url", "review");
  if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/iu.test(displayText)) add("email", "review");
  if (/[A-Za-z]{2,}/u.test(speechText)) add("unreviewed_latin", "review");

  return [...risks].map(([code, severity]) => ({ code, severity }));
}

const THAI_ONLY_TOKEN_RE = /^[\p{Script=Thai}]+$/u;
const NUMERIC_TOKEN_RE = /^[+-]?\d[\d,.]*%?$/u;
const NON_THAI_CHAR_RE = /[^\p{Script=Thai}\s]/u;

function normalizeSpeechSegment(segment: string): string {
  const structuredText = normalizeThaiSpeechUnits(
    normalizeThaiSpeechPercents(
      normalizeThaiSpeechCurrencies(
        normalizeThaiSpeechRanges(
          normalizeThaiSpeechDimensions(
            normalizeThaiSpeechCodes(
              normalizeThaiSpeechAbbreviations(
                normalizeThaiSpeechDates(
                  normalizeThaiSpeechTimes(
                    expandThaiRepetitionMarks(applyThaiPronunciationDictionary(segment)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return spellUnlistedAcronyms(normalizeThaiSpeechNumbers(structuredText));
}

/**
 * Glue rule (Mew-approved by ear, 2026-09-06): OmniVoice reads spelled-out numbers
 * and transliterated words correctly only when they are written attached to their
 * Thai neighbours, the way Thai is written by hand ("มีสินค้ายี่สิบเอ็ดชิ้น"). So a
 * source space survives only between two Thai-only words, after punctuation, or
 * between two bare numbers; every other space (around digits, Latin, symbols) is
 * removed after normalization. Normalization runs per surviving segment so that
 * multi-token rules (1920 x 1080, วันที่ 5 กันยายน 2026, Hero AI Studio) stay intact.
 */
function keepsSpaceBefore(previous: string, token: string): boolean {
  if (token === "ๆ" || token === "%") return false;
  if (previous === "%") return NUMERIC_TOKEN_RE.test(token);
  if (THAI_ONLY_TOKEN_RE.test(previous) && THAI_ONLY_TOKEN_RE.test(token)) return true;
  if (/[,.;:!?]$/u.test(previous)) return true;
  return NUMERIC_TOKEN_RE.test(previous) && NUMERIC_TOKEN_RE.test(token);
}

function normalizeSpeechText(unicodeText: string): string {
  const parts = unicodeText.split(/(\s+)/u);
  const tokens: string[] = [];
  const gaps: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0) {
      if (parts[index]) tokens.push(parts[index]);
    } else if (tokens.length > 0) {
      gaps[tokens.length - 1] = parts[index];
    }
  }
  if (tokens.length === 0) return normalizeSpeechSegment(unicodeText);
  const leading = /^\s+/u.exec(unicodeText)?.[0] ?? "";
  const trailing = /\s+$/u.exec(unicodeText)?.[0] ?? "";
  const segments: Array<{ text: string; gapAfter: string }> = [];
  let current = tokens[0];
  for (let index = 1; index < tokens.length; index += 1) {
    const gap = gaps[index - 1] ?? " ";
    if (keepsSpaceBefore(tokens[index - 1], tokens[index])) {
      segments.push({ text: current, gapAfter: gap });
      current = tokens[index];
    } else {
      current += `${gap}${tokens[index]}`;
    }
  }
  segments.push({ text: current, gapAfter: "" });
  const rendered = segments.map(({ text, gapAfter }) => {
    const normalized = normalizeSpeechSegment(text);
    const glued = NON_THAI_CHAR_RE.test(text) ? normalized.replace(/\s+/gu, "") : normalized;
    return `${glued}${gapAfter}`;
  });
  return `${leading}${rendered.join("")}${trailing}`;
}

/** Build the provider text and privacy-safe risk categories without changing display text. */
export function prepareHeroVoiceSpeech(displayText: string): HeroVoiceSpeechPreparation {
  const unicodeText = normalizeThaiDigits(displayText.normalize("NFC"));
  const speechText = normalizeSpeechText(unicodeText);
  return {
    speechText,
    risks: speechRisks(displayText, speechText),
    normalizerVersion: HERO_VOICE_SPEECH_NORMALIZER_VERSION,
  };
}

/** Compatibility helper for callers that only need provider text. */
export function prepareHeroVoiceSpeechText(displayText: string): string {
  return prepareHeroVoiceSpeech(displayText).speechText;
}

export interface HeroVoiceSpeechChunk {
  text: string;
  speechText: string;
  risks: HeroVoiceSpeechRisk[];
  startChar: number;
  endChar: number;
}

function speechChunk(text: string, startChar: number): HeroVoiceSpeechChunk {
  const prepared = prepareHeroVoiceSpeech(text);
  return {
    text,
    speechText: prepared.speechText,
    risks: prepared.risks,
    startChar,
    endChar: startChar + text.length,
  };
}

function refineSpeechChunk(
  text: string,
  startChar: number,
  maxSpeechChars: number,
): HeroVoiceSpeechChunk[] {
  const whole = speechChunk(text, startChar);
  if (whole.speechText.length <= maxSpeechChars) return [whole];

  const parts = [...THAI_WORD_SEGMENTER.segment(text)];
  const chunks: HeroVoiceSpeechChunk[] = [];
  let localStart = 0;
  let localEnd = 0;

  for (const part of parts) {
    const partEnd = part.index + part.segment.length;
    const candidate = speechChunk(text.slice(localStart, partEnd), startChar + localStart);
    if (candidate.speechText.length <= maxSpeechChars) {
      localEnd = partEnd;
      continue;
    }

    if (localEnd > localStart) {
      chunks.push(speechChunk(text.slice(localStart, localEnd), startChar + localStart));
      localStart = localEnd;
    }

    const singlePart = speechChunk(text.slice(localStart, partEnd), startChar + localStart);
    if (singlePart.speechText.length > maxSpeechChars) {
      throw new RangeError("Hero Voice pronunciation is too long for one speech chunk");
    }
    localEnd = partEnd;
  }

  if (localEnd > localStart) {
    chunks.push(speechChunk(text.slice(localStart, localEnd), startChar + localStart));
  }
  return chunks;
}

/** Split on display-text boundaries while enforcing the provider's speech-text limit. */
/**
 * Sentence boundaries for OmniVoice chunking: a Thai sentence-final particle or
 * terminal punctuation followed by whitespace, or a line break. The whitespace
 * stays with the preceding chunk so chunks still concatenate to the display text.
 */
const SENTENCE_END_RE = /(?:ครับ|ค่ะ|คะ|[.!?…])\s+|\n+/gu;
const MIN_SENTENCE_CHUNK_CHARS = 10;

interface DisplaySpan { text: string; startChar: number; endChar: number; }

/**
 * Mew-approved by ear (2026-09-06): OmniVoice rushes and slurs toward the end of a
 * long single generation, and the fix is generating one sentence at a time and
 * concatenating. Tiny fragments (a lone "ครับ") are merged into the previous
 * sentence so the model never gets a one-word job.
 */
function splitDisplaySentences(displayText: string): DisplaySpan[] {
  const spans: DisplaySpan[] = [];
  let position = 0;
  const push = (end: number) => {
    if (end <= position) return;
    const text = displayText.slice(position, end);
    const previous = spans[spans.length - 1];
    if (previous && text.trim().length < MIN_SENTENCE_CHUNK_CHARS) {
      previous.text += text;
      previous.endChar = end;
    } else {
      spans.push({ text, startChar: position, endChar: end });
    }
    position = end;
  };
  for (const match of displayText.matchAll(SENTENCE_END_RE)) {
    push((match.index ?? 0) + match[0].length);
  }
  push(displayText.length);
  return spans;
}

export function splitHeroVoiceScriptForTts(
  displayText: string,
  maxSpeechChars: number,
): HeroVoiceSpeechChunk[] {
  const limit = Math.max(1, Math.floor(maxSpeechChars));
  return splitDisplaySentences(displayText).flatMap((sentence) => (
    splitScriptForTts(sentence.text, limit).flatMap((chunk) => (
      refineSpeechChunk(chunk.text, sentence.startChar + chunk.startChar, limit)
    ))
  ));
}
