/**
 * verify-envato.ts — เช็คว่า Envato Market API ตอบ shape ตามที่ fetch-stock assume
 * (matches[].id / .name / .previews.icon_with_video_preview.video_url / attributes "length")
 *
 * Usage:
 *   ENVATO_TOKEN=xxx npx tsx scripts/verify-envato.ts [query]
 *   (PowerShell: $env:ENVATO_TOKEN="xxx"; npx tsx scripts/verify-envato.ts "city night")
 */

const token = process.env.ENVATO_TOKEN;
const query = process.argv[2] ?? "city aerial";

if (!token) {
  console.error("❌ ตั้ง ENVATO_TOKEN ก่อน — สร้าง personal token ที่ https://build.envato.com/my-apps/");
  process.exit(1);
}

function parseLength(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map(p => parseInt(p, 10));
  if (parts.some(isNaN) || parts.length === 0) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

async function main() {
  const params = new URLSearchParams({
    term: query,
    site: "videohive.net",
    category: "stock-footage",
    page_size: "5",
    sort_by: "relevance",
  });
  const res = await fetch(`https://api.envato.com/v1/discovery/search/search/item?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`GET search/item "${query}" → ${res.status}`);
  if (!res.ok) {
    console.error(await res.text().catch(() => ""));
    process.exit(1);
  }
  const data = await res.json();
  const matches = data.matches ?? [];
  console.log(`matches: ${matches.length} (total_hits: ${data.total_hits ?? "?"})\n`);

  let okCount = 0;
  for (const item of matches) {
    const videoUrl =
      item.previews?.icon_with_video_preview?.video_url ??
      item.previews?.video_preview?.video_url ?? "";
    const lengthAttr = item.attributes?.find((a: { name?: string }) => a.name === "length")?.value;
    const duration = parseLength(lengthAttr);
    const ok = !!videoUrl;
    if (ok) okCount++;
    console.log(`${ok ? "✓" : "✗"} #${item.id} "${(item.name ?? "").slice(0, 50)}"`);
    console.log(`   length=${String(lengthAttr)} (${duration}s)  video_url=${videoUrl ? videoUrl.slice(0, 90) : "—— ไม่พบ (เช็ค previews keys: " + Object.keys(item.previews ?? {}).join(",") + ")"}`);
  }

  console.log(`\n${okCount}/${matches.length} items มี preview video URL ตาม shape ที่ fetch-stock ใช้`);
  if (matches.length > 0 && okCount === 0) {
    console.log("⚠️ shape ไม่ตรง — ดู previews keys ด้านบนแล้วปรับ searchEnvato ใน fetch-stock/route.ts");
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
