// Retry wrapper: retries transport errors + 5xx, NOT 4xx; gives up after N; injectable sleep.
//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-pipeline-retry.ts
import { withRetry } from "../src/lib/mcp/pipeline-client";

let passed = 0;
function assert(c: boolean, m: string) { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); passed++; }
const noSleep = () => Promise.resolve();

async function main() {
  let n1 = 0;
  const ok = await withRetry(async () => { n1++; if (n1 < 3) throw new Error("fetch failed"); return "ok"; }, { sleep: noSleep });
  assert(ok === "ok" && n1 === 3, "retries transport error then succeeds (3rd try)");

  let n2 = 0;
  let threw = false;
  try { await withRetry(async () => { n2++; throw new Error("POST /x → 503: boom"); }, { retries: 2, sleep: noSleep }); } catch { threw = true; }
  assert(threw && n2 === 3, "retries 5xx up to N then gives up (1+2)");

  let n3 = 0;
  try { await withRetry(async () => { n3++; throw new Error("POST /x → 400: bad"); }, { retries: 2, sleep: noSleep }); } catch {}
  assert(n3 === 1, "does NOT retry 4xx (in-band error) — fails immediately");

  console.log(`\n${passed} assertions passed ✅`);
}

main().catch((e) => { console.error(e); process.exit(1); });
