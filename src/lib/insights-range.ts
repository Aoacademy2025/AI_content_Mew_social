export const INSIGHTS_RANGE_DAYS = [1, 7, 30] as const;

export type InsightsRangeDays = (typeof INSIGHTS_RANGE_DAYS)[number];

type SearchParams = Pick<URLSearchParams, "get" | "getAll" | "toString">;

export function readInsightsRange(searchParams: SearchParams): InsightsRangeDays {
  const values = searchParams.getAll("days");
  const value = values.length === 1 ? values[0] : null;
  return INSIGHTS_RANGE_DAYS.find((days) => String(days) === value) ?? 1;
}

export function insightsRangeHref(pathname: string, searchParams: Pick<URLSearchParams, "toString">, days: InsightsRangeDays) {
  const next = new URLSearchParams(searchParams.toString());
  next.set("days", String(days));
  return `${pathname}?${next.toString()}`;
}
