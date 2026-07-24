// T6 (hv-emotion) — Step 2: build pack/index.html, a fully offline single-file
// blind listening test. Deliberately does NOT read answer-key.json or winners.json
// — the public trial list here only ever needs trialId/groupIndex/scriptId/
// scriptText, which are all derivable from persona COUNT + script text alone
// (no persona/config identity is present in this script at all, so there is
// nothing here that could leak into the HTML by mistake).
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const PACK_ROOT = path.resolve(__dirname, "..", "artifacts", "hero-voice-ab-2026-07-24", "pack");
const PERSONA_COUNT = 16;

const SCRIPT_IDS = ["S1", "S2", "S3"] as const;
const SCRIPT_TEXT: Record<string, string> = {
  S1: "หยุดเลื่อนก่อน! ถ้าคุณทำคลิปสั้นแล้วยอดไม่ขึ้นสักที วันนี้มีคำตอบ เพราะปัญหาไม่ใช่คอนเทนต์คุณไม่ดี แต่คุณพลาดสามวินาทีแรกต่างหาก เดี๋ยวเล่าให้ฟังว่าแก้ยังไง",
  S2: "เมื่อวันที่ 15 มีนาคม 2568 ร้านเล็กๆ ร้านหนึ่งในเชียงใหม่ เริ่มโพสต์คลิปวันละ 1 คลิป ผ่านไป 90 วัน ยอดขายเพิ่มขึ้น 250 เปอร์เซ็นต์ จากลูกค้าแค่ 20 คนต่อเดือน กลายเป็น 500 คน เคล็ดลับของเขาไม่ใช่โชค แต่คือความสม่ำเสมอ และการเล่าเรื่องที่คนฟังแล้วรู้สึกว่า เรื่องนี้มันคือเรา",
  S3: "ลองใช้ HERO AI Creator Studio ดูสิครับ แค่วางสคริปต์ ระบบจะใส่เสียงพากย์ ซับไตเติล และ B-roll ให้อัตโนมัติ ไม่ต้องเปิด Premiere ไม่ต้องจ้างทีมตัดต่อ สมัครวันนี้ ทดลองใช้ฟรี 7 วัน แล้วคุณจะรู้ว่าทำคลิปมันง่ายกว่าที่คิด",
};
const SCRIPT_LABEL_TH: Record<string, string> = {
  S1: "สคริปต์ 1 — Hook เปิดคลิป (ไม่มีตัวเลข)",
  S2: "สคริปต์ 2 — เนื้อเรื่อง + ตัวเลข/วันที่",
  S3: "สคริปต์ 3 — CTA ปิดท้าย (มีคำทับศัพท์อังกฤษ)",
};

type PublicTrial = { trialId: string; groupIndex: number; scriptId: string };
const trials: PublicTrial[] = [];
let idx = 0;
for (let g = 1; g <= PERSONA_COUNT; g++) {
  for (const scriptId of SCRIPT_IDS) {
    idx += 1;
    trials.push({ trialId: `t${String(idx).padStart(2, "0")}`, groupIndex: g, scriptId });
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function trialCardHtml(trial: PublicTrial): string {
  const slots: Array<{ slot: "a" | "b" | "c"; labelNum: 1 | 2 | 3 }> = [
    { slot: "a", labelNum: 1 },
    { slot: "b", labelNum: 2 },
    { slot: "c", labelNum: 3 },
  ];
  const players = slots
    .map(
      ({ slot, labelNum }) => `
      <div class="arm" data-trial="${trial.trialId}" data-slot="${slot}">
        <div class="arm-head">เสียง ${labelNum}</div>
        <audio controls preload="none" src="${trial.trialId}/${trial.trialId}_${slot}.wav"></audio>
        <div class="rating-row">
          <label>ความเป็นธรรมชาติ
            <select class="rate-natural" data-trial="${trial.trialId}" data-slot="${slot}">
              <option value="">-</option>
              <option value="1">1</option><option value="2">2</option><option value="3">3</option>
              <option value="4">4</option><option value="5">5</option>
            </select>
          </label>
          <label>อารมณ์
            <select class="rate-emotion" data-trial="${trial.trialId}" data-slot="${slot}">
              <option value="">-</option>
              <option value="1">1</option><option value="2">2</option><option value="3">3</option>
              <option value="4">4</option><option value="5">5</option>
            </select>
          </label>
        </div>
      </div>`,
    )
    .join("\n");

  const preferRadios = slots
    .map(
      ({ slot, labelNum }) => `
        <label class="prefer-opt"><input type="radio" name="prefer_${trial.trialId}" value="${slot}" data-trial="${trial.trialId}"> เสียง ${labelNum}</label>`,
    )
    .join("");

  return `
  <article class="trial" id="${trial.trialId}">
    <h3>${SCRIPT_LABEL_TH[trial.scriptId]}</h3>
    <p class="script-text">"${esc(SCRIPT_TEXT[trial.scriptId])}"</p>
    <div class="arms">${players}</div>
    <div class="prefer">
      <span class="prefer-label">ชอบอันไหนสุด:</span>
      ${preferRadios}
    </div>
    <label class="comment-label">ความเห็นเพิ่มเติม (ถ้ามี)
      <textarea class="comment" data-trial="${trial.trialId}" rows="2"></textarea>
    </label>
  </article>`;
}

const groupedHtml = Array.from({ length: PERSONA_COUNT }, (_, i) => i + 1)
  .map((g) => {
    const groupTrials = trials.filter((t) => t.groupIndex === g);
    return `
  <section class="group">
    <h2>กลุ่มเสียงที่ ${g}</h2>
    ${groupTrials.map(trialCardHtml).join("\n")}
  </section>`;
  })
  .join("\n");

const trialIds = trials.map((t) => t.trialId);

const html = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hero Voice — ทดสอบฟังแบบปิดตา (Blind A/B)</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: "Bai Jamjuree", "Sarabun", system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 16px; line-height: 1.6; }
  header { position: sticky; top: 0; background: Canvas; padding: 12px 0; border-bottom: 2px solid #8b5cf6; z-index: 10; }
  h1 { font-size: 1.3rem; margin: 0 0 8px; }
  .instructions { background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.3); border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 0.95rem; }
  .instructions ul { margin: 6px 0 0; padding-left: 20px; }
  .progress { font-size: 0.9rem; margin-top: 6px; }
  button.export-btn { background: #8b5cf6; color: white; border: none; border-radius: 8px; padding: 10px 20px; font-size: 1rem; cursor: pointer; margin: 8px 0; }
  button.export-btn:hover { background: #7c3aed; }
  .group { margin: 28px 0; padding-top: 8px; border-top: 3px solid rgba(139,92,246,0.25); }
  .group h2 { font-size: 1.1rem; color: #8b5cf6; }
  .trial { border: 1px solid rgba(128,128,128,0.3); border-radius: 10px; padding: 14px; margin: 14px 0; }
  .trial h3 { margin: 0 0 6px; font-size: 1rem; }
  .script-text { font-size: 0.92rem; opacity: 0.85; margin: 0 0 10px; }
  .arms { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
  .arm { border: 1px solid rgba(128,128,128,0.25); border-radius: 8px; padding: 8px; }
  .arm-head { font-weight: 600; margin-bottom: 4px; }
  .arm audio { width: 100%; margin-bottom: 6px; }
  .rating-row { display: flex; gap: 10px; font-size: 0.85rem; flex-wrap: wrap; }
  .rating-row select { margin-left: 4px; }
  .prefer { margin-top: 10px; font-size: 0.92rem; }
  .prefer-label { font-weight: 600; margin-right: 8px; }
  .prefer-opt { margin-right: 12px; }
  .comment-label { display: block; margin-top: 8px; font-size: 0.85rem; }
  .comment { width: 100%; box-sizing: border-box; margin-top: 4px; font-family: inherit; }
  footer { margin: 24px 0 60px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Hero Voice — ทดสอบฟังแบบปิดตา (Blind A/B)</h1>
  <div class="instructions">
    <strong>วิธีฟัง:</strong>
    <ul>
      <li>ฟังด้วยหูฟัง (headphone) ในที่เงียบ ๆ</li>
      <li>ตัดสินที่ <strong>อารมณ์และความเป็นธรรมชาติ</strong> ของเสียง ไม่ใช่สำเนียงหรือคาแรกเตอร์เสียงอย่างเดียว</li>
      <li>แต่ละ "trial" มี 3 คลิปเสียง (เสียง 1 / เสียง 2 / เสียง 3) ให้คะแนนแต่ละอันแล้วเลือกว่าชอบอันไหนสุด</li>
      <li>ทำครบแล้วกดปุ่ม "ส่งออกผลเป็นไฟล์" ด้านล่างเพื่อบันทึกผลเป็นไฟล์ JSON (ไม่มีการส่งข้อมูลออกอินเทอร์เน็ต)</li>
    </ul>
    <div class="progress" id="progress">ตอบแล้ว: 0 / ${trialIds.length} trial</div>
  </div>
  <button class="export-btn" id="exportBtn">ส่งออกผลเป็นไฟล์</button>
</header>

<main>
${groupedHtml}
</main>

<footer>
  <button class="export-btn" id="exportBtn2">ส่งออกผลเป็นไฟล์</button>
</footer>

<script>
(function () {
  var TRIAL_IDS = ${JSON.stringify(trialIds)};
  var SLOTS = ["a", "b", "c"];

  function collectResults() {
    var results = {};
    TRIAL_IDS.forEach(function (trialId) {
      var trialData = { arms: {}, preferred: null, comment: "" };
      SLOTS.forEach(function (slot) {
        var natSel = document.querySelector('.rate-natural[data-trial="' + trialId + '"][data-slot="' + slot + '"]');
        var emoSel = document.querySelector('.rate-emotion[data-trial="' + trialId + '"][data-slot="' + slot + '"]');
        trialData.arms[slot] = {
          naturalness: natSel && natSel.value ? Number(natSel.value) : null,
          emotion: emoSel && emoSel.value ? Number(emoSel.value) : null,
        };
      });
      var preferChecked = document.querySelector('input[name="prefer_' + trialId + '"]:checked');
      trialData.preferred = preferChecked ? preferChecked.value : null;
      var commentEl = document.querySelector('.comment[data-trial="' + trialId + '"]');
      trialData.comment = commentEl ? commentEl.value.trim() : "";
      results[trialId] = trialData;
    });
    return results;
  }

  function isTrialComplete(trialData) {
    var allRated = SLOTS.every(function (slot) {
      var a = trialData.arms[slot];
      return a.naturalness !== null && a.emotion !== null;
    });
    return allRated && trialData.preferred !== null;
  }

  function updateProgress() {
    var results = collectResults();
    var done = 0;
    TRIAL_IDS.forEach(function (id) {
      if (isTrialComplete(results[id])) done += 1;
    });
    document.getElementById("progress").textContent = "ตอบแล้ว: " + done + " / " + TRIAL_IDS.length + " trial";
  }

  document.addEventListener("change", updateProgress);
  document.addEventListener("input", updateProgress);

  function exportResults() {
    var results = collectResults();
    var payload = {
      exportedAt: new Date().toISOString(),
      trialCount: TRIAL_IDS.length,
      results: results,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "hero-voice-ab-results-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  document.getElementById("exportBtn").addEventListener("click", exportResults);
  document.getElementById("exportBtn2").addEventListener("click", exportResults);

  updateProgress();
})();
</script>
</body>
</html>
`;

mkdirSync(PACK_ROOT, { recursive: true });
writeFileSync(path.join(PACK_ROOT, "index.html"), html);
console.log(JSON.stringify({ event: "pack-html-written", trials: trials.length, path: path.join(PACK_ROOT, "index.html") }));
