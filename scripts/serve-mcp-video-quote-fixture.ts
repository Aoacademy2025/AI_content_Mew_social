/** Isolated browser fixture: never loaded by Next or production auth.
 * Run with node --import ./scripts/register-server-only-node.mjs --import tsx …
 * Creates its own disposable SQLite and uses the production component/service/HTTP adapter.
 * Only the Clerk identity boundary is replaced with named synthetic fixture sessions.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "hero-quote-browser-"));
  process.env.DATABASE_URL = `file:${join(temp, "fixture.db")}`;
  process.env.MINUTE_QUOTA = "1"; process.env.CREDITS_LIVE = "1"; process.env.HERO_AI_IMAGE_PUBLIC = "1";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:4319";
  execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], { env: process.env, stdio: "pipe" });
  const { prisma } = await import("../src/lib/prisma");
  const { prepareVideoQuote, getVideoQuoteReview } = await import("../src/lib/mcp/video-quote.server");
  const { createQuoteHttpHandlers } = await import("../src/lib/mcp/video-quote-http");
  const owner = await prisma.user.create({ data: { name: "Fixture Owner", email: "browser-owner@example.test", role: "USER", plan: "PRO", stripeSubscriptionId: "fixture-subscription", subStatus: "active", planExpiresAt: new Date(Date.now() + 86400000), minutesLimit: 100, usagePeriodStartedAt: new Date() } });
  const other = await prisma.user.create({ data: { name: "Other Fixture", email: "browser-other@example.test" } });
  await prisma.creditBalance.create({ data: { userId: owner.id, purchased: 100 } });
  await prisma.payment.create({ data: { userId: owner.id, stripeSessionId: "fixture-payment", plan: "PRO", amount: 100, status: "PAID", paidAt: new Date() } });
  const input = { script: "นี่คือสคริปต์ตัวอย่างสำหรับทดสอบใบยืนยันค่าใช้จ่ายเท่านั้น ไม่มีข้อมูลของลูกค้า เราจะสร้างวิดีโอสั้นจากเรื่องราวที่คุณเลือก พร้อมตรวจภาพประกอบและคำบรรยายก่อนส่งออก", title: "ตัวอย่างใบยืนยัน · ข้อมูลทดสอบ", brollSource: "automix" as const };
  const approve = await prepareVideoQuote(owner, input);
  const reject = await prepareVideoQuote(owner, { ...input, brollSource: "external" });
  if ("error" in approve || "error" in reject) throw new Error(`fixture preparation failed: ${"error" in approve ? approve.code : "error" in reject ? reject.code : "unknown"}`);
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {QuoteConfirmation} from './src/app/(dashboard)/mcp/confirm/[quoteId]/quote-confirmation'; fetch('/fixture-review'+location.pathname).then(async r=>{const data=await r.json(); if(!r.ok){document.getElementById('root').textContent=data.message;return;} createRoot(document.getElementById('root')).render(React.createElement(QuoteConfirmation,data));});`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
  const css = await postcss([tailwindcss()]).process(readFileSync("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") });
  const menu = `<nav style="padding:16px;border-bottom:1px solid #555;display:flex;gap:20px;flex-wrap:wrap"><strong>ISOLATED FIXTURE</strong><a href="/fixture/signed-out">Signed out</a><a href="/fixture/wrong-owner">Wrong owner</a><a href="/fixture/approve">Owner approve</a><a href="/fixture/reject">Owner reject</a></nav>`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://127.0.0.1:4319");
      const fixture = url.pathname.match(/^\/fixture\/(signed-out|wrong-owner|approve|reject)$/)?.[1];
      if (fixture) { res.writeHead(302, { "Set-Cookie": `fixture-session=${fixture}; HttpOnly; SameSite=Strict; Path=/`, Location: `/mcp/confirm/${fixture === "reject" ? reject.quoteId : approve.quoteId}` }); res.end(); return; }
      if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
      if (url.pathname === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.css); return; }
      const session = req.headers.cookie?.match(/fixture-session=([^;]+)/)?.[1];
      const userId = session === "wrong-owner" ? other.id : session === "approve" || session === "reject" ? owner.id : null;
      const review = url.pathname.match(/^\/fixture-review\/mcp\/confirm\/([^/]+)$/)?.[1];
      if (review) {
        const data = userId ? await getVideoQuoteReview(userId, review) : null;
        res.writeHead(data ? 200 : userId ? 404 : 401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data ?? { message: userId ? "ไม่พบใบยืนยันนี้" : "กรุณาเข้าสู่ระบบ Studio ด้วยบัญชีเจ้าของงาน" })); return;
      }
      const quoteId = url.pathname.match(/^\/api\/mcp-quotes\/([^/]+)$/)?.[1];
      if (quoteId) {
        let body = ""; for await (const chunk of req) body += chunk;
        const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(req.method === "POST" ? { body } : {}) });
        const handlers = createQuoteHttpHandlers(async () => userId);
        const reply = await (req.method === "POST" ? handlers.POST : handlers.GET)(request, { params: Promise.resolve({ quoteId }) });
        res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(await reply.text()); return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!DOCTYPE html><html lang="th"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>HERO quote · isolated fixture</title><link rel="stylesheet" href="/style.css"></head><body style="font-family:Tahoma,sans-serif">${menu}<div id="root" style="min-height:80vh;padding:8px">Loading fixture…</div><script src="/bundle.js"></script></body></html>`);
    } catch { res.writeHead(500); res.end("Fixture error"); }
  });
  server.listen(4319, "127.0.0.1", () => console.log("Fixture ready: http://127.0.0.1:4319/fixture/signed-out — synthetic sessions and disposable DB only"));
  const cleanup = async () => { server.close(); await prisma.$disconnect(); rmSync(temp, { recursive: true, force: true }); process.exit(0); };
  process.on("SIGINT", cleanup); process.on("SIGTERM", cleanup);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
