// Runs every ~15 min via PM2 cron to self-heal stale PROCESSING videos that
// already have a valid output file. Calls the internal API with CRON_SECRET.
const https = require("https");
const http = require("http");

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";

const url = `${BASE_URL}/api/cron/reconcile-processing?dryRun=0&staleAfterMinutes=180&failAfterHours=24&failMissingOutput=0`;
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
  const req = client.request(url, options, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      console.log(`[reconcile-processing] ${new Date().toISOString()} status=${res.statusCode} body=${data}`);
      process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1);
    });
  });

  req.on("timeout", () => {
    req.destroy();
    console.error("[reconcile-processing] Request timed out");
    if (retries > 0) {
      console.log(`[reconcile-processing] Retrying in 10s... (${retries} left)`);
      setTimeout(() => attempt(retries - 1), 10000);
    } else {
      process.exit(1);
    }
  });

  req.on("error", (err) => {
    console.error(`[reconcile-processing] Error: ${err.code || ""} ${err.message || ""}`);
    if (retries > 0) {
      console.log(`[reconcile-processing] Retrying in 10s... (${retries} left)`);
      setTimeout(() => attempt(retries - 1), 10000);
    } else {
      process.exit(1);
    }
  });

  req.end();
}

attempt(3);
