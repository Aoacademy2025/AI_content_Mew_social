// Unit tests for the Render Receipt (D5) pure decision logic.
// Run: npx tsx scripts/verify-render-receipt.ts
//
// buildReceipt decides WHICH receipt lines show + the interpolated numbers (X minutes,
// N AI credits, M overflow minutes). It reuses the server's minute rounding
// (minutesFromSeconds) and the window planner's credit math (estimatePresetCredits), so
// these tests pin the disclosure numbers to the same model the server charges from.
import { buildReceipt, type ReceiptInput, type ReceiptModel } from "../src/app/(dashboard)/video-editor/_v2/receipt";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const keys = (m: ReceiptModel) => m.lines.map((l) => l.key);
const has = (m: ReceiptModel, k: string) => m.lines.some((l) => l.key === k);
const text = (m: ReceiptModel, k: string) => m.lines.find((l) => l.key === k)?.text ?? "";

const base: ReceiptInput = {
  estSec: 60,
  remainingMinutes: 10,
  totalMinutes: 10,
  usesAi: false,
  presetWeights: { video: 3, photo: 2, ai: 1 },
  perImageCredits: 3, // gpt-image-2 (image-gpt-1k)
  creditBalance: 100,
  minuteCreditRate: 2,
  hasAvatar: false,
};
const R = (o: Partial<ReceiptInput>) => buildReceipt({ ...base, ...o });

// ── A. ฟรีล้วน (usesAi false): minutes + disclaimer only ──
const a = R({ usesAi: false });
check("A: minutes line always present", has(a, "minutes"));
check("A: disclaimer always present", has(a, "disclaimer"));
check("A: no AI line when !usesAi", !has(a, "ai"));
check("A: no overflow when within package", !has(a, "overflow"));
check("A: no insufficient when !usesAi (0 credits)", !has(a, "insufficient"), JSON.stringify(keys(a)));
check("A: no avatar line when hasAvatar false", !has(a, "avatar"));
check("A: minutes first, disclaimer last", a.lines[0].key === "minutes" && a.lines[a.lines.length - 1].key === "disclaimer");

// ── B. recommended within package + ample balance ──
const b = R({ usesAi: true, perImageCredits: 3, creditBalance: 100 });
check("B: AI line shown when usesAi", has(b, "ai"));
check("B: estCredits = 9 (60s @ 3:2:1, 3cr/img, 4s window)", b.estCredits === 9, `N=${b.estCredits}`);
check("B: AI copy interpolates N", text(b, "ai") === "ภาพ AI (ประมาณ): ~9 เครดิต · หักตามจำนวนที่เจนสำเร็จจริง", text(b, "ai"));
check("B: estMinutes = 1 (60s → nearest)", b.estMinutes === 1, `X=${b.estMinutes}`);
check("B: minutes copy interpolates X/Y/Z", text(b, "minutes") === "นาทีที่จะใช้ (ประมาณ): 1 นาที — รวมในแพ็กเกจ (เหลือ 10 จาก 10 นาที)", text(b, "minutes"));
check("B: no overflow (1 ≤ 10)", !has(b, "overflow"));
check("B: no insufficient (9 ≤ 100)", !has(b, "insufficient"));

// ── C. overflow: estMinutes > remaining ──
const c = R({ estSec: 480, remainingMinutes: 3, totalMinutes: 10, usesAi: false });
check("C: estMinutes = 8 (480s)", c.estMinutes === 8, `X=${c.estMinutes}`);
check("C: overflowMinutes M = 5", c.overflowMinutes === 5, `M=${c.overflowMinutes}`);
check("C: overflow line shown", has(c, "overflow"));
check("C: overflow copy interpolates M and 2×M", text(c, "overflow") === "นาทีในแพ็กเกจไม่พอ — ส่วนที่เกิน ~5 นาที จะหักเครดิต 10 เครดิต (2 เครดิต/นาที)", text(c, "overflow"));
check("C: overflow line kind = warn", c.lines.find((l) => l.key === "overflow")?.kind === "warn");

// ── D. boundary: minutes EXACTLY equal → no overflow (strict >) ──
const d = R({ estSec: 300, remainingMinutes: 5, totalMinutes: 10, usesAi: false });
check("D: estMinutes = 5 (300s)", d.estMinutes === 5, `X=${d.estMinutes}`);
check("D: X == Y → no overflow warning", !has(d, "overflow"));
check("D: overflowMinutes = 0 at equality", d.overflowMinutes === 0);

// ── E. zero balance + AI → insufficient ──
const e = R({ usesAi: true, perImageCredits: 3, creditBalance: 0 });
check("E: estCredits = 9 > balance 0 → insufficient shown", has(e, "insufficient"));
check("E: insufficient copy exact", text(e, "insufficient") === "เครดิตอาจไม่พอ — ระบบจะใช้ภาพสต็อกแทนช่วงที่เครดิตหมด", text(e, "insufficient"));

// ── F. boundary: estCredits EXACTLY equal balance → no insufficient (strict >) ──
const f = R({ usesAi: true, perImageCredits: 3, creditBalance: 9 });
check("F: N == balance → no insufficient warning", !has(f, "insufficient"), `N=${f.estCredits} bal=9`);

// ── G. boundary: estSec = 0 → estMinutes floors to 1 ──
const g = R({ estSec: 0 });
check("G: estSec 0 → estMinutes 1 (floor)", g.estMinutes === 1, `X=${g.estMinutes}`);
check("G: minutes line still present", has(g, "minutes"));

// ── H. minutes quota unknown (null) → fallback copy, never overflow ──
const h = R({ estSec: 3600, remainingMinutes: null, totalMinutes: null, usesAi: false });
check("H: minutes fallback copy (no เหลือ tail)", text(h, "minutes") === "นาทีที่จะใช้ (ประมาณ): 60 นาที — รวมในแพ็กเกจ", text(h, "minutes"));
check("H: no overflow when quota unknown", !has(h, "overflow"));
check("H: overflowMinutes = 0 when quota unknown", h.overflowMinutes === 0);

// ── I. avatar line shows when hasAvatar ──
const i = R({ hasAvatar: true });
check("I: avatar line shown", has(i, "avatar"));
check("I: avatar copy exact", text(i, "avatar") === "อวตาร HeyGen: คิดค่าใช้จ่ายผ่านคีย์ HeyGen ของคุณ (ไม่หักเครดิต/นาทีเพิ่ม)", text(i, "avatar"));

// ── J. insufficient never fires when !usesAi even at 0 balance ──
const j = R({ usesAi: false, creditBalance: 0 });
check("J: !usesAi + 0 balance → no insufficient", !has(j, "insufficient"));
check("J: estCredits = 0 when !usesAi", j.estCredits === 0);

// ── K. AI 'เต็มที่' (full: 0/0/1) all windows AI → larger N ──
const k = R({ estSec: 60, usesAi: true, presetWeights: { video: 0, photo: 0, ai: 1 }, perImageCredits: 4, creditBalance: 500 });
check("K: full preset 60s @ 4cr/img → N = 60 (15 windows × 4)", k.estCredits === 60, `N=${k.estCredits}`);

// ── L. disclaimer copy exact ──
check("L: disclaimer copy exact", text(a, "disclaimer") === "ตัวเลขเป็นประมาณการ — ยอดจริงคำนวณจากความยาวเสียงจริงหลังสร้างเสียง", text(a, "disclaimer"));

// ── M. upload duration exact: no "(ประมาณ)" on minutes, upload-specific disclaimer ──
const m = R({ estSec: 184.128, exactDuration: true });
check("M: exact upload 184s → 3 minutes", m.estMinutes === 3, `X=${m.estMinutes}`);
check("M: exact minutes copy omits ประมาณ", text(m, "minutes") === "นาทีที่จะใช้: 3 นาที — รวมในแพ็กเกจ (เหลือ 10 จาก 10 นาที)", text(m, "minutes"));
check("M: exact disclaimer copy", text(m, "disclaimer") === "ความยาวคลิปคำนวณจากไฟล์ที่อัปโหลดจริง", text(m, "disclaimer"));

// ── N. Hero AI Image never promises a hidden stock fallback ──
const n = R({ usesAi: true, creditBalance: 0, insufficientCreditBehavior: "block" });
check("N: Hero image insufficient balance blocks before generation", text(n, "insufficient") === "เครดิตอาจไม่พอ — Hero AI Image จะไม่เริ่มงานจนกว่าเครดิตจะพอครบทุกฉาก", text(n, "insufficient"));

// ── O. Explicit B-roll count uses the same source planner as the render ──
const oHero = R({
  estSec: 600,
  usesAi: true,
  presetWeights: { video: 0, photo: 0, ai: 1 },
  perImageCredits: 2,
  targetClipCount: 5,
});
check("O1: Hero manual 5 reports exactly 5 × 2 = 10 credits", oHero.estCredits === 10, `N=${oHero.estCredits}`);
check("O1: exact manual Hero copy does not use an approximate amount", text(oHero, "ai") === "ภาพ AI: 10 เครดิต (5 ภาพ × 2 เครดิต) · หักเมื่อเจนสำเร็จ", text(oHero, "ai"));

const oMix = R({
  estSec: 600,
  usesAi: true,
  presetWeights: { video: 3, photo: 2, ai: 1 },
  perImageCredits: 2,
  targetClipCount: 6,
});
check("O2: AutoMix manual 6 reports the planner's one AI slot", oMix.estCredits === 2, `N=${oMix.estCredits}`);

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nAll render-receipt checks passed.");
