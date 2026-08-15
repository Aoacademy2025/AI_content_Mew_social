// Runs daily via PM2 cron to sweep safe junk and alert admins when disk is high.
// Calls the internal API route with CRON_SECRET for auth.
const https = require("https");
const http = require("http");

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";

const url = `${BASE_URL}/api/cron/disk-watch`;
const isHttps = url.startsWith("https");
const client = isHttps ? https : http;

const options = {
  method: "GET",
  timeout: 60000,
  headers: {
    ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
  },
};

function attempt(retries) {
  let settled = false;
  const fail = (message) => {
    if (settled) return;
    settled = true;
    console.error(`[disk-watch] ${message}`);
    if (retries > 0) {
      console.log(`[disk-watch] Retrying in 10s... (${retries} left)`);
      setTimeout(() => attempt(retries - 1), 10000);
    } else {
      process.exit(1);
    }
  };

  const req = client.request(url, options, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      if (settled) return;
      const statusCode = res.statusCode || 0;
      console.log(`[disk-watch] ${new Date().toISOString()} status=${statusCode} body=${data}`);
      if (statusCode >= 200 && statusCode < 300) {
        settled = true;
        process.exit(0);
      } else {
        fail(`HTTP ${statusCode}`);
      }
    });
  });

  req.on("timeout", () => {
    fail("Request timed out");
    req.destroy();
  });

  req.on("error", (err) => {
    fail(`Error: ${err.code || ""} ${err.message || ""}`);
  });

  req.end();
}

attempt(3);
