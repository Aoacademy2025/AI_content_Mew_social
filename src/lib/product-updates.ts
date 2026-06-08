export const APP_VERSION_FALLBACK = process.env.NEXT_PUBLIC_APP_VERSION ?? "v0.1.0";

export const PRODUCT_UPDATE_CATEGORIES = [
  "FEATURE",
  "IMPROVEMENT",
  "FIX",
  "PATCH",
  "KNOWN_ISSUE",
  "IN_PROGRESS",
] as const;

export const PRODUCT_UPDATE_STATES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

export type ProductUpdateCategoryValue = typeof PRODUCT_UPDATE_CATEGORIES[number];
export type ProductUpdateStateValue = typeof PRODUCT_UPDATE_STATES[number];

export function normalizeUpdateCategory(value: unknown): ProductUpdateCategoryValue {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  return PRODUCT_UPDATE_CATEGORIES.includes(raw as ProductUpdateCategoryValue)
    ? raw as ProductUpdateCategoryValue
    : "IMPROVEMENT";
}

export function normalizeUpdateState(value: unknown): ProductUpdateStateValue {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  return PRODUCT_UPDATE_STATES.includes(raw as ProductUpdateStateValue)
    ? raw as ProductUpdateStateValue
    : "DRAFT";
}

export function cleanUpdateString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  if (!next) return null;
  return next.slice(0, max);
}

export function parseUpdateDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}
