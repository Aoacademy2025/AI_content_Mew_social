// Daily counts-only MAPC snapshot. No user IDs, emails, prompts, or output URLs
// are written to NorthStarDailySnapshot.
const https = require("https");
const http = require("http");

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";
const url = `${BASE_URL}/api/cron/north-star-snapshot`;
const client = url.startsWith("https") ? https : http;
const options = { method: "GET", timeout: 30000, headers: { ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}) } };

function attempt(retries) {
  const req = client.request(url, options, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      console.log(`[north-star-snapshot] ${new Date().toISOString()} status=${res.statusCode} body=${data}`);
      process.exit(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
    });
  });
  req.on("timeout", () => {
    req.destroy();
    console.error("[north-star-snapshot] timed out");
    retries > 0 ? setTimeout(() => attempt(retries - 1), 10000) : process.exit(1);
  });
  req.on("error", (error) => {
    console.error(`[north-star-snapshot] ${error.code || ""} ${error.message || ""}`);
    retries > 0 ? setTimeout(() => attempt(retries - 1), 10000) : process.exit(1);
  });
  req.end();
}

attempt(3);
