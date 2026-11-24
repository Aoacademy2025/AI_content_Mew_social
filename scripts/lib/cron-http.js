// Shared HTTP runner for one-shot PM2 cron launchers (HERO-127).
// Guarantees single settlement per attempt so `req.on("timeout")` calling
// `req.destroy()` and emitting `req.on("error", ECONNRESET)` never schedules
// duplicate or exponential retries.
const https = require("https");
const http = require("http");

function parseEnvNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function runCronHttp({
  name,
  path,
  timeoutMs = 90000,
  retries = 1,
  retryDelayMs = 10000,
}) {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET || "";
  const url = `${baseUrl}${path}`;
  const client = url.startsWith("https") ? https : http;

  const effectiveTimeoutMs = parseEnvNonNegativeInt("CRON_HTTP_TIMEOUT_MS", timeoutMs);
  const effectiveRetries = parseEnvNonNegativeInt("CRON_HTTP_RETRIES", retries);
  const effectiveRetryDelayMs = parseEnvNonNegativeInt("CRON_HTTP_RETRY_DELAY_MS", retryDelayMs);

  const options = {
    method: "GET",
    timeout: effectiveTimeoutMs,
    headers: {
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
  };

  function attempt(remainingRetries) {
    let settled = false;

    const fail = (message, { retryable = true } = {}) => {
      if (settled) return;
      settled = true;
      console.error(`[${name}] ${message}`);
      if (retryable && remainingRetries > 0) {
        console.log(
          `[${name}] Retrying in ${Math.round(effectiveRetryDelayMs / 1000)}s... (${remainingRetries} left)`,
        );
        setTimeout(() => attempt(remainingRetries - 1), effectiveRetryDelayMs);
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
        console.log(`[${name}] ${new Date().toISOString()} status=${statusCode} body=${data}`);
        if (statusCode >= 200 && statusCode < 300) {
          settled = true;
          process.exit(0);
          return;
        }
        // Retry only transient 5xx responses (e.g., 503 database lock timeout).
        // Deterministic 4xx responses (401 auth error, 409 already-running) exit immediately.
        fail(`HTTP ${statusCode}`, { retryable: statusCode >= 500 });
      });
      res.on("error", (err) => {
        fail(`Response error: ${err.code || ""} ${err.message || ""}`, { retryable: true });
      });
    });

    req.on("timeout", () => {
      fail(`Request timed out after ${effectiveTimeoutMs}ms`, { retryable: true });
      req.destroy();
    });

    req.on("error", (err) => {
      fail(`Error: ${err.code || ""} ${err.message || ""}`, { retryable: true });
    });

    req.end();
  }

  attempt(effectiveRetries);
}

module.exports = { runCronHttp };
