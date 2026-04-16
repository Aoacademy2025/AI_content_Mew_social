export const FREE_LIMITS = {
  styles: 2,
  contents: 5,
  images: Infinity, // unlimited
} as const;

export function isPaid(plan: string) {
  return plan === "PRO";
}
