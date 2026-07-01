import { planCutaway, buildEnableExpr } from "../src/lib/cutaway-plan";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗", msg); failed++; } else { console.log("✓", msg); }
}

// windows tiling [0, n*4s] at 4s each (mirrors buildBrollWindows output shape)
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000 }));

// 1) hook (window 0) is always person
assert(planCutaway(mk(6)).person.some(r => r.startMs === 0), "window 0 (hook) is person");

// 2) alternation => b-roll only on odd windows (=> never two consecutive)
assert(
  JSON.stringify(planCutaway(mk(6)).broll.map(r => r.startMs)) === JSON.stringify([4000, 12000, 20000]),
  "b-roll on odd windows only (no consecutive)",
);

// 3) person + broll cover all windows, disjoint
{
  const { person, broll } = planCutaway(mk(5));
  assert(person.length + broll.length === 5, "person+broll count == window count");
  const starts = [...person, ...broll].map(r => r.startMs).sort((a, b) => a - b);
  assert(JSON.stringify(starts) === JSON.stringify([0, 4000, 8000, 12000, 16000]), "union covers all windows, disjoint");
}

// 4) < 2 windows => all person, no cutaway
{
  const { person, broll } = planCutaway(mk(1));
  assert(person.length === 1 && broll.length === 0, "1 window => all person, no b-roll");
  assert(planCutaway([]).person.length === 0 && planCutaway([]).broll.length === 0, "0 windows => empty plan");
}

// 5) b-roll ratio ~40-50% for typical lengths
{
  const ratio = planCutaway(mk(10)).broll.length / 10;
  assert(ratio >= 0.4 && ratio <= 0.5, `b-roll ratio ${ratio} within 0.4-0.5`);
}

// 6) enable expr formatting
assert(
  buildEnableExpr([{ start: 0, end: 3.5 }, { start: 8, end: 12 }]) === "between(t,0.000,3.500)+between(t,8.000,12.000)",
  "enable expr joins ranges with +",
);
assert(buildEnableExpr([]) === "", "empty ranges => empty expr");

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
