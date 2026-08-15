// Runs every ~15 min via PM2 cron to settle-or-refund AI image credit
// reservations that got stuck at chargeState="reserved" (RunPod status-poll
// outage, or a hard deadline reached while the job was still queued).
// Calls the internal API with CRON_SECRET.
const https = require("https");
const http = require("http");

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";

const url = `${BASE_URL}/api/cron/reconcile-ai-images?dryRun=0&olderThanMinutes=30&limit=50`;
const isHttps = url.startsWith("https");
const client = isHttps ? https : http;

const options = {
  method: "GET",
  timeout: 120000,
  headers: {
    ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
  },
};

function attempt(retries) {
  const req = client.request(url, options, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      console.log(`[reconcile-ai-images] ${new Date().toISOString()} status=${res.statusCode} body=${data}`);
      process.exit(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
    });
  });

  req.on("timeout", () => {
    req.destroy();
    console.error("[reconcile-ai-images] Request timed out");
    if (retries > 0) {
      console.log(`[reconcile-ai-images] Retrying in 10s... (${retries} left)`);
      setTimeout(() => attempt(retries - 1), 10000);
    } else {
      process.exit(1);
    }
  });

  req.on("error", (err) => {
    console.error(`[reconcile-ai-images] Error: ${err.code || ""} ${err.message || ""}`);
    if (retries > 0) {
      console.log(`[reconcile-ai-images] Retrying in 10s... (${retries} left)`);
      setTimeout(() => attempt(retries - 1), 10000);
    } else {
      process.exit(1);
    }
  });

  req.end();
}

attempt(3);
