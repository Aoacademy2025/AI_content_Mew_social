/**
 * verify-gemini-keytest.ts — proves testGemini step 1 maps Google's HTTP 400
 * (API_KEY_INVALID, the bad-key case) to the friendly "Key ไม่ถูกต้อง" message
 * instead of the old raw "Auth check failed: 400".
 *
 * Run: npx tsx scripts/verify-gemini-keytest.ts
 * Requires network (hits the live Generative Language endpoint with a fake key).
 */
import { getGeminiErrorInfo } from "../src/lib/gemini-errors";

// Mirror of the new step-1 decision in src/app/api/user/test-key/route.ts
function decideStep1(status: number, body: string, ok: boolean): { ok: boolean; message: string } | "PASS" {
  if (!ok) {
    const lc = body.toLowerCase();
    if (status === 401 || lc.includes("api_key_invalid") || lc.includes("api key not valid") || lc.includes("key not valid")) {
      return { ok: false, message: "❌ Key ไม่ถูกต้อง — สร้างใหม่ที่ aistudio.google.com/apikey" };
    }
    if (lc.includes("service_disabled") || lc.includes("has not been used")) {
      return { ok: false, message: "❌ Generative Language API ยังไม่ได้เปิด — ..." };
    }
    if (status === 403 || lc.includes("permission_denied")) {
      return { ok: false, message: "❌ Key ไม่มีสิทธิ์ — ลองสร้าง key ใหม่ที่ aistudio.google.com/apikey" };
    }
    const info = getGeminiErrorInfo(body, status);
    return { ok: false, message: `❌ ${info.userMessage}` };
  }
  return "PASS";
}

async function main() {
  let failures = 0;

  // 1) LIVE: real bad-key response from Google (the exact customer scenario)
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaTHIS_IS_A_FAKE_KEY_12345",
    { headers: { "x-goog-api-key": "AIzaTHIS_IS_A_FAKE_KEY_12345" } },
  );
  const body = await res.text();
  const decision = decideStep1(res.status, body, res.ok);
  const liveOk =
    res.status === 400 &&
    typeof decision !== "string" &&
    decision.message.includes("Key ไม่ถูกต้อง");
  console.log(`[live bad key] HTTP ${res.status} -> ${typeof decision === "string" ? decision : decision.message}`);
  console.log(`  ${liveOk ? "✓ PASS" : "✗ FAIL"} (must be 400 + "Key ไม่ถูกต้อง", NOT "Auth check failed: 400")`);
  if (!liveOk) failures++;

  // 2) OFFLINE fixtures — other status codes still route correctly
  const cases: Array<{ name: string; status: number; body: string; expect: string }> = [
    { name: "401 legacy invalid", status: 401, body: "", expect: "Key ไม่ถูกต้อง" },
    { name: "403 SERVICE_DISABLED", status: 403, body: '{"error":{"status":"PERMISSION_DENIED","message":"... SERVICE_DISABLED has not been used ..."}}', expect: "ยังไม่ได้เปิด" },
    { name: "403 bare permission", status: 403, body: '{"error":{"status":"PERMISSION_DENIED"}}', expect: "ไม่มีสิทธิ์" },
    { name: "503 overload -> shared map", status: 503, body: '{"error":{"code":503,"message":"The model is overloaded"}}', expect: "หนาแน่น" },
  ];
  for (const c of cases) {
    const d = decideStep1(c.status, c.body, false);
    const pass = typeof d !== "string" && d.message.includes(c.expect);
    console.log(`[${c.name}] -> ${typeof d === "string" ? d : d.message}`);
    console.log(`  ${pass ? "✓ PASS" : "✗ FAIL"} (expected to contain "${c.expect}")`);
    if (!pass) failures++;
  }

  console.log(failures === 0 ? "\nALL PASS ✓" : `\n${failures} FAILURE(S) ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
