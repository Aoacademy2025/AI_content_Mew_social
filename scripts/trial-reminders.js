// Runs daily via PM2 cron to send the trial lifecycle nudges (2 days left / expiry day /
// day +3). Calls the internal API route with CRON_SECRET for auth. The route itself is a
// no-op unless TRIAL_REMINDERS=1.
const https = require("https");
const http = require("http");

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";

const url = `${BASE_URL}/api/cron/trial-reminders`;
const client = url.startsWith("https") ? https : http;
const options = { method: "GET", timeout: 30000, headers: { ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}) } };

function attempt(retries) {
  const req = client.request(url, options, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => { console.log(`[trial-reminders] ${new Date().toISOString()} status=${res.statusCode} body=${data}`); process.exit(0); });
  });
  req.on("timeout", () => { req.destroy(); console.error("[trial-reminders] timed out"); retries > 0 ? setTimeout(() => attempt(retries - 1), 10000) : process.exit(1); });
  req.on("error", (e) => { console.error(`[trial-reminders] ${e.code || ""} ${e.message || ""}`); retries > 0 ? setTimeout(() => attempt(retries - 1), 10000) : process.exit(1); });
  req.end();
}
attempt(3);
