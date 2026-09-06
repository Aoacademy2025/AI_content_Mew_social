/** Upload audio to Gemini File API. Key is sent only in x-goog-api-key, never in the URL. */
export async function uploadGeminiAudioFile(
  geminiKey: string,
  buffer: Buffer,
  mimeType: string,
): Promise<{ fileUri: string; fileName: string }> {
  const uploadRes = await fetch(
    "https://generativelanguage.googleapis.com/upload/v1beta/files",
    {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "x-goog-api-key": geminiKey,
        "X-Goog-Upload-Protocol": "raw",
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Header-Content-Length": String(buffer.length),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      signal: AbortSignal.timeout(120_000),
      body: new Uint8Array(buffer),
    },
  );
  if (!uploadRes.ok) {
    const errBody = await uploadRes.text().catch(() => "");
    throw new Error(`Gemini File API upload failed: ${uploadRes.status} — ${errBody.slice(0, 200)}`);
  }
  const uploadData = await uploadRes.json() as { file?: { uri?: string; name?: string } };
  const fileUri = uploadData?.file?.uri;
  const fileName = uploadData?.file?.name;
  if (!fileUri || !fileName) throw new Error("Gemini File API did not return file URI");
  return { fileUri, fileName };
}

export async function deleteGeminiFile(geminiKey: string, fileName: string): Promise<void> {
  await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
    method: "DELETE",
    headers: { "x-goog-api-key": geminiKey },
  }).catch(() => {});
}

export function offsetToSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/s$/i, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    const rec = value as { seconds?: unknown; nanos?: unknown };
    const seconds = typeof rec.seconds === "number" ? rec.seconds : Number(rec.seconds ?? 0);
    const nanos = typeof rec.nanos === "number" ? rec.nanos : 0;
    if (!Number.isFinite(seconds)) return null;
    return seconds + (Number.isFinite(nanos) ? nanos / 1e9 : 0);
  }
  return null;
}

export function collectRawWords(node: unknown, out: Array<{ word?: string; start?: number; end?: number; startMs?: number; endMs?: number }> = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectRawWords(item, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const rec = node as Record<string, unknown>;
  const token = rec.word ?? rec.w ?? rec.text;
  if (typeof token === "string" && token.trim()) {
    const startMs = typeof rec.startMs === "number" ? rec.startMs
      : typeof rec.start_ms === "number" ? rec.start_ms
      : null;
    const endMs = typeof rec.endMs === "number" ? rec.endMs
      : typeof rec.end_ms === "number" ? rec.end_ms
      : null;
    const start = offsetToSeconds(rec.start ?? rec.start_time ?? rec.startOffset ?? rec.start_offset);
    const end = offsetToSeconds(rec.end ?? rec.end_time ?? rec.endOffset ?? rec.end_offset);
    if (startMs != null && endMs != null) {
      out.push({ word: token.trim(), startMs, endMs });
    } else if (start != null && end != null) {
      out.push({ word: token.trim(), start, end });
    }
  }
  for (const key of ["words", "output", "outputs", "content", "items", "annotations", "result", "transcription"]) {
    if (key in rec) collectRawWords(rec[key], out);
  }
  return out;
}

export function wordsToSegments(words: Array<{ word: string; start: number; end: number }>): Array<{ text: string; start: number; end: number }> {
  if (words.length === 0) return [];
  const thai = words.some((word) => /[ก-๙]/.test(word.word));
  const join = (parts: string[]) => (thai ? parts.join("") : parts.join(" ").replace(/\s+/g, " ").trim());
  const segments: Array<{ text: string; start: number; end: number }> = [];
  let bucket = [words[0]];
  let start = words[0].start;
  let end = words[0].end;
  for (const word of words.slice(1)) {
    if (word.start - end >= 0.6) {
      segments.push({ text: join(bucket.map((item) => item.word)), start, end });
      bucket = [word];
      start = word.start;
      end = word.end;
    } else {
      bucket.push(word);
      end = word.end;
    }
  }
  segments.push({ text: join(bucket.map((item) => item.word)), start, end });
  return segments.filter((segment) => segment.text.length > 0);
}
