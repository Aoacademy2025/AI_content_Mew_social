import { computeDisplayPrice } from "../src/lib/pricing-display";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        got:  ${g}\n        want: ${w}`);
  }
}

// 1) Monthly, no discount
check("monthly / none",
  computeDisplayPrice({ monthlyPrice: 599, period: "monthly", coupon: null, founding: null }),
  { base: 599, final: 599, pct: 0, isFounding: false });

// 2) Annual, no discount
check("annual / none",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: null, founding: null }),
  { base: 5990, final: 5990, pct: 0, isFounding: false });

// 3) Annual + founding 50% -> 2995 (matches the live integration check)
check("annual / founding 50%",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: null, founding: { active: true, percentOff: 50 } }),
  { base: 5990, final: 2995, pct: 50, isFounding: true });

// 4) Monthly + founding active -> founding does NOT apply (annual-only)
check("monthly / founding ignored",
  computeDisplayPrice({ monthlyPrice: 599, period: "monthly", coupon: null, founding: { active: true, percentOff: 50 } }),
  { base: 599, final: 599, pct: 0, isFounding: false });

// 5) Annual + coupon 20%, no founding
check("annual / coupon 20%",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: { percentOff: 20 }, founding: null }),
  { base: 5990, final: 4792, pct: 20, isFounding: false });

// 6) Coupon beats founding (both present)
check("annual / coupon beats founding",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: { percentOff: 20 }, founding: { active: true, percentOff: 50 } }),
  { base: 5990, final: 4792, pct: 20, isFounding: false });

// 7) Founding sold out / inactive
check("annual / founding inactive",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: null, founding: { active: false, percentOff: 50 } }),
  { base: 5990, final: 5990, pct: 0, isFounding: false });

// 8) Annual + fixed-amount coupon (percentOff null) -> no percent shown, founding suppressed
check("annual / coupon fixed-amount (percentOff null)",
  computeDisplayPrice({ monthlyPrice: 599, period: "annual", coupon: { percentOff: null }, founding: null }),
  { base: 5990, final: 5990, pct: 0, isFounding: false });

// 9) Monthly + coupon 20%
check("monthly / coupon 20%",
  computeDisplayPrice({ monthlyPrice: 599, period: "monthly", coupon: { percentOff: 20 }, founding: null }),
  { base: 599, final: 479, pct: 20, isFounding: false });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll pricing-display checks passed");
