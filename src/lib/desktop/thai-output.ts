const THAI_CP = /[\u0E00-\u0E7F]/;

export function stripForThaiCheck(text: string, productName: string): string {
  let out = text.normalize("NFC");
  out = out.replace(/https?:\/\/\S+|www\.\S+/gi, "");
  out = out.replace(/#\S+/g, "");
  out = out.replace(/\p{Extended_Pictographic}/gu, "");
  out = out.replace(/[\uFE0E\uFE0F\u200D]/g, "");
  const name = productName.trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "");
  }
  return out;
}

export function thaiCodePointRatio(text: string): number {
  if (text.length === 0) return 0;
  let thai = 0;
  for (const ch of text) {
    if (THAI_CP.test(ch)) thai++;
  }
  return thai / [...text].length;
}

/** ≥ 60% Thai code points after removing hashtags, URLs, emoji and the Product name. */
export function passesThaiOutput(text: string, productName: string): boolean {
  return thaiCodePointRatio(stripForThaiCheck(text, productName)) >= 0.60;
}
