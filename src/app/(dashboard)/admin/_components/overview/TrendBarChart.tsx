"use client";

// One inline SVG bar chart per trend card (brief: no chart library). A single per-day
// transparent hit-rect carries the browser-native hover/tap tooltip via <title> — the
// simplest accessible mechanism that needs no JS state and adds no animation.

const GRID = "var(--ui-card-border)";
const LEFT_MARGIN = 14;
const TOP_MARGIN = 6;
const PLOT_H = 60;
const BASELINE_Y = TOP_MARGIN + PLOT_H;
const AXIS_LABEL_Y = BASELINE_Y + 9;
const HEIGHT = AXIS_LABEL_Y + 5;
const SLOT = 16;

const dayMonthFmt = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" });

/** Bangkok noon for a `YYYY-MM-DD` day key — safe to format in any Intl timeZone. */
export function bangkokDateFromKey(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00+07:00`);
}

export interface TrendBarSeries {
  key: string;
  color: string;
  values: number[];
}

interface TrendBarChartProps {
  dates: string[];
  bars: TrendBarSeries[];
  overlay?: { color: string; values: number[] };
  layout: "single" | "grouped" | "stacked";
  tooltipText: (index: number) => string;
  ariaLabel: string;
}

export function TrendBarChart({ dates, bars, overlay, layout, tooltipText, ariaLabel }: TrendBarChartProps) {
  const n = dates.length;
  const width = LEFT_MARGIN + n * SLOT;

  const dayTotal = (i: number) =>
    layout === "stacked" ? bars.reduce((sum, b) => sum + b.values[i], 0) : Math.max(0, ...bars.map((b) => b.values[i]));
  const rawMax = Math.max(1, ...dates.map((_, i) => Math.max(dayTotal(i), overlay ? overlay.values[i] : 0)));
  const scale = (v: number) => (v / rawMax) * PLOT_H;

  const ticks = [1 / 3, 2 / 3, 1].map((f) => ({ y: BASELINE_Y - PLOT_H * f, value: Math.round(rawMax * f) }));

  return (
    <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="block h-auto w-full" role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t.y}>
          <line x1={LEFT_MARGIN} x2={width} y1={t.y} y2={t.y} stroke={GRID} strokeWidth={0.5} />
          <text x={LEFT_MARGIN - 2} y={t.y + 2} textAnchor="end" fontSize={5} fill="var(--ui-text-muted)">{t.value}</text>
        </g>
      ))}
      <line x1={LEFT_MARGIN} x2={width} y1={BASELINE_Y} y2={BASELINE_Y} stroke={GRID} strokeWidth={0.75} />

      {dates.map((date, i) => {
        const cx = LEFT_MARGIN + i * SLOT + SLOT / 2;
        const segments: React.ReactNode[] = [];

        if (layout === "single" && bars[0]) {
          const h = scale(bars[0].values[i]);
          segments.push(
            <rect key="v" x={cx - SLOT * 0.3} y={BASELINE_Y - h} width={SLOT * 0.6} height={h} rx={1.5} fill={bars[0].color} />,
          );
        }

        if (layout === "grouped") {
          const bw = SLOT * 0.32;
          const gap = SLOT * 0.06;
          bars.forEach((b, bi) => {
            const h = scale(b.values[i]);
            const x = cx - bw - gap / 2 + bi * (bw + gap);
            segments.push(<rect key={b.key} x={x} y={BASELINE_Y - h} width={bw} height={h} rx={1} fill={b.color} />);
          });
          if (overlay) {
            const h = scale(overlay.values[i]);
            segments.push(<rect key="overlay" x={cx - SLOT * 0.09} y={BASELINE_Y - h} width={SLOT * 0.18} height={h} rx={1} fill={overlay.color} />);
          }
        }

        if (layout === "stacked") {
          let yCursor = BASELINE_Y;
          for (const b of bars) {
            const h = scale(b.values[i]);
            if (h <= 0) continue;
            yCursor -= h;
            segments.push(<rect key={b.key} x={cx - SLOT * 0.3} y={yCursor} width={SLOT * 0.6} height={h} rx={1} fill={b.color} />);
            yCursor -= 1; // 1-unit gap between stacked segments
          }
        }

        return (
          <g key={date}>
            {segments}
            {i % 7 === 0 && (
              <text x={cx} y={AXIS_LABEL_Y} textAnchor="middle" fontSize={5} fill="var(--ui-text-muted)">
                {dayMonthFmt.format(bangkokDateFromKey(date))}
              </text>
            )}
            <rect x={LEFT_MARGIN + i * SLOT} y={0} width={SLOT} height={BASELINE_Y} fill="transparent">
              <title>{tooltipText(i)}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
