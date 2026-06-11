// Verify pollJob — the shared hardened poll loop for render/burn.
// Run: npx tsx scripts/verify-poll-job.ts
import {
  pollJob, nextBackoffDelay,
  PollStaleError, PollAbortError, PollFailedError, PollTransientLimitError,
} from "../src/app/(dashboard)/video-editor/_lib/poll-job";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

async function main() {
  // (a) 502 HTML body → res.json() throws SyntaxError → transient, retried, NOT fatal
  {
    let calls = 0;
    const result = await pollJob<string>({
      intervalMs: 5,
      staleTimeoutMs: 60_000,
      backoffCapMs: 10,
      fetchOnce: async () => {
        calls++;
        if (calls <= 2) {
          // exactly what r.json() does when Nginx serves a 502 HTML error page
          JSON.parse("<html><body>502 Bad Gateway</body></html>");
        }
        return { status: "done", value: "https://example.com/out.mp4" };
      },
    });
    check("(a) 502-HTML is retried, not fatal",
      result === "https://example.com/out.mp4" && calls === 3,
      `calls=${calls} result=${result}`);
  }

  // (b) frozen progress → rejects with PollStaleError, code "stale"
  {
    let err: unknown = null;
    try {
      await pollJob<string>({
        intervalMs: 5,
        staleTimeoutMs: 40,
        fetchOnce: async () => ({ status: "pending", progress: 42 }),
      });
    } catch (e) { err = e; }
    check("(b) stale timeout fires when progress frozen",
      err instanceof PollStaleError && err.code === "stale", String(err));
  }

  // (b2) changing progress keeps resetting the stale clock — never goes stale
  {
    let p = 0; let err: unknown = null; let result = "";
    const seen: number[] = [];
    try {
      result = await pollJob<string>({
        intervalMs: 5,
        staleTimeoutMs: 40,
        onProgress: v => seen.push(v),
        fetchOnce: async () => {
          p++;
          if (p >= 20) return { status: "done", value: "ok" }; // ~100ms total > 40ms stale window
          return { status: "pending", progress: p };
        },
      });
    } catch (e) { err = e; }
    check("(b2) changing progress never goes stale + onProgress fires",
      err === null && result === "ok" && seen.length === 19 && seen[0] === 1,
      `err=${String(err)} seen=${seen.length}`);
  }

  // (c) backoff: 1.5x growth, hard cap
  {
    check("(c1) backoff grows 1.5x", nextBackoffDelay(2000, 15_000) === 3000,
      `got ${nextBackoffDelay(2000, 15_000)}`);
    let d = 2000;
    for (let i = 0; i < 20; i++) d = nextBackoffDelay(d, 15_000);
    check("(c2) backoff caps at 15s", d === 15_000, `d=${d}`);
    let err: unknown = null; let calls = 0;
    try {
      await pollJob<string>({
        intervalMs: 1, backoffCapMs: 2, staleTimeoutMs: 60_000, maxTransientErrors: 5,
        fetchOnce: async () => { calls++; throw new Error("boom"); },
      });
    } catch (e) { err = e; }
    check("(c3) gives up after maxTransientErrors consecutive errors",
      err instanceof PollTransientLimitError && calls === 5, `calls=${calls} err=${String(err)}`);
  }

  // (d) abort stops cleanly with name === "AbortError" (existing catch blocks rely on it)
  {
    const ac = new AbortController();
    let calls = 0;
    const pending = pollJob<string>({
      intervalMs: 5, staleTimeoutMs: 60_000, signal: ac.signal,
      fetchOnce: async () => { calls++; return { status: "pending", progress: 1 }; },
    });
    setTimeout(() => ac.abort(), 25);
    let err: unknown = null;
    try { await pending; } catch (e) { err = e; }
    const callsAtAbort = calls;
    await new Promise(r => setTimeout(r, 30));
    check("(d) abort rejects with AbortError and polling stops",
      err instanceof PollAbortError && (err as Error).name === "AbortError" && calls === callsAtAbort,
      `err=${String(err)} calls=${calls} callsAtAbort=${callsAtAbort}`);
  }

  // (e) a "failed" tick is terminal and carries the job's error message
  {
    let err: unknown = null;
    try {
      await pollJob<string>({
        intervalMs: 5,
        fetchOnce: async () => ({ status: "failed", error: "Render failed: out of memory" }),
      });
    } catch (e) { err = e; }
    check("(e) job failure is terminal with original message",
      err instanceof PollFailedError && (err as Error).message === "Render failed: out of memory",
      String(err));
  }

  if (failures > 0) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nALL PASS");
}

main().catch(e => { console.error(e); process.exit(1); });
