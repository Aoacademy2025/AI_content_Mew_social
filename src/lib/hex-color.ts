/** Normalize creator-entered HEX without accepting browser RGB/HSL syntax. */
export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.split("").map((digit) => digit.repeat(2)).join("")}`.toUpperCase();
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw}`.toUpperCase() : null;
}

/** Canonicalize one creator-facing Brand palette as six-digit uppercase HEX.
 * Descriptive prose is deliberately rejected: it belongs in personality or
 * visualNotes, while palette values are also rendered by native color UI. */
export function normalizeHexPalette(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) return null;
  const normalized = input.map(normalizeHexColor);
  return normalized.every((color): color is string => color !== null) ? normalized : null;
}
