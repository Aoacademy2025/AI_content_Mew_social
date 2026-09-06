/** Parses one RFC 7233 byte range. Multiple ranges are deliberately rejected
 * because the private review endpoint never emits multipart responses. */
export function parseHeroVoiceCanaryAudioRange(
  value: string | null,
  size: number,
): readonly [number, number] | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (value === null) return [0, size - 1];
  const match = /^bytes=([0-9]*)-([0-9]*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    return Number.isSafeInteger(suffixLength) && suffixLength > 0
      ? [Math.max(0, size - suffixLength), size - 1]
      : null;
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  return Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd)
    && start >= 0 && start < size && requestedEnd >= start
    ? [start, end]
    : null;
}
