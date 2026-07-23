import { splitScriptForTts } from "@/lib/tts-timing";

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
const THAI_WORD_SEGMENTER = new Intl.Segmenter("th", { granularity: "word" });
const THAI_ACCENT_PRONUNCIATIONS = [
  ["Your Brain on ChatGPT", "ยัวร์ เบรน ออน แชต จี พี ที"],
  ["Richard Benjamins", "ริชาร์ด เบนจามินส์"],
  ["Roske AI", "รอสก์ เอไอ"],
  ["Telefonica", "เทเลโฟนิกา"],
  ["ChatGPT", "แชต จี พี ที"],
  ["Benjamins", "เบนจามินส์"],
  ["Richard", "ริชาร์ด"],
  ["Google", "กูเกิล"],
  ["Brain", "เบรน"],
  ["Roske", "รอสก์"],
  ["Your", "ยัวร์"],
  ["MIT", "เอ็ม ไอ ที"],
  ["AI", "เอไอ"],
  ["on", "ออน"],
] as const;
const THAI_ENGLISH_LETTER_NAMES: Record<string, string> = {
  A: "เอ", B: "บี", C: "ซี", D: "ดี", E: "อี", F: "เอฟ", G: "จี",
  H: "เอช", I: "ไอ", J: "เจ", K: "เค", L: "แอล", M: "เอ็ม", N: "เอ็น",
  O: "โอ", P: "พี", Q: "คิว", R: "อาร์", S: "เอส", T: "ที", U: "ยู",
  V: "วี", W: "ดับเบิลยู", X: "เอ็กซ์", Y: "วาย", Z: "แซด",
};
const DIGIT_SEQUENCE_CONTEXT_RE = /(เบอร์(?:โทร(?:ศัพท์)?)?|โทรศัพท์|OTP|PIN)(\s*)(\d(?:[\d -]*\d)?)/giu;

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
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart, decimalPart] = unsigned.split(".");
  const integerWords = thaiIntegerWords(integerPart);
  const decimalWords = decimalPart
    ? `จุด${[...decimalPart].map((digit) => THAI_DIGIT_WORDS[Number(digit)]).join("")}`
    : "";
  return `${negative ? "ลบ" : ""}${integerWords}${decimalWords}`;
}

function digitsIndividually(text: string): string {
  return text.replace(/\d/g, (digit) => THAI_DIGIT_WORDS[Number(digit)]);
}

function normalizeThaiSpeechNumbers(text: string): string {
  return text
    .replace(
      DIGIT_SEQUENCE_CONTEXT_RE,
      (_match, prefix: string, spacing: string, digits: string) => (
        `${prefix}${spacing}${digitsIndividually(digits)}`
      ),
    )
    .replace(/-?\d[\d,]*(?:\.\d+)?/g, (number, offset: number, source: string) => {
      const attachedHyphen = number.startsWith("-")
        && offset > 0
        && /[\p{L}\p{M}\p{N}]/u.test(source[offset - 1]);
      return attachedHyphen
        ? `-${thaiNumberWords(number.slice(1))}`
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

function applyThaiAccentPronunciations(text: string): string {
  const aliased = THAI_ACCENT_PRONUNCIATIONS.reduce((result, [written, spoken]) => {
    const phrase = escapeRegExp(written).replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`(^|[^A-Za-z])${phrase}(?=$|[^A-Za-z])`, "giu");
    return result.replace(pattern, (_match, prefix: string) => `${prefix}${spoken}`);
  }, text);
  return aliased.replace(/\b[A-Z]{2,6}\b/g, (acronym) => (
    [...acronym].map((letter) => THAI_ENGLISH_LETTER_NAMES[letter]).join(" ")
  ));
}

/** Build the text spoken by Hero AI Voice without changing the display script. */
export function prepareHeroVoiceSpeechText(displayText: string): string {
  return applyThaiAccentPronunciations(
    normalizeThaiSpeechNumbers(expandThaiRepetitionMarks(displayText)),
  );
}

export interface HeroVoiceSpeechChunk {
  text: string;
  speechText: string;
  startChar: number;
  endChar: number;
}

function speechChunk(text: string, startChar: number): HeroVoiceSpeechChunk {
  return {
    text,
    speechText: prepareHeroVoiceSpeechText(text),
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
export function splitHeroVoiceScriptForTts(
  displayText: string,
  maxSpeechChars: number,
): HeroVoiceSpeechChunk[] {
  const limit = Math.max(1, Math.floor(maxSpeechChars));
  return splitScriptForTts(displayText, limit).flatMap((chunk) => (
    refineSpeechChunk(chunk.text, chunk.startChar, limit)
  ));
}
