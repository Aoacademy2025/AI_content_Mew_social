// Runs daily via PM2 cron to delete expired videos (older than 7 days)
// Calls the internal API route with CRON_SECRET for auth
const https = require("https");
const http = require("http");

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SECRET = process.env.CRON_SECRET || "";

const url = `${BASE_URL}/api/cron/cleanup-videos`;
const isHttps = url.startsWith("https");
const client = isHttps ? https : http;

const options = {
  method: "GET",
  headers: {
    ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
  },
};

const req = client.request(url, options, (res) => {
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    console.log(`[cleanup-videos] ${new Date().toISOString()} status=${res.statusCode} body=${data}`);
    process.exit(0);
  });
});

req.on("error", (err) => {
  console.error(`[cleanup-videos] Error: ${err.message}`);
  process.exit(1);
});

req.end();
