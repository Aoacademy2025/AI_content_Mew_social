/** Normalize creator-entered HEX without accepting browser RGB/HSL syntax. */
export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.split("").map((digit) => digit.repeat(2)).join("")}`.toUpperCase();
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw}`.toUpperCase() : null;
}
