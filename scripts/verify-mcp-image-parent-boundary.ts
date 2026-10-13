/** Public HTTP boundary for the internal image-parent mismatch advisory. No provider calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
const directory = mkdtempSync(join(tmpdir(), "image-parent-boundary-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
process.env.HERO_AI_IMAGE_PUBLIC = "1";
process.env.CREDITS_LIVE = "1";
globalThis.fetch = async () => { throw new Error("Provider/network forbidden"); };
execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], { env: process.env, stdio: "pipe" });
async function main() {
  const { prisma } = await import("../src/lib/prisma");
  try {
    const user = await prisma.user.create({ data: { email: "parent@example.test", name: "Owner", role: "USER", plan: "PRO", minutesLimit: 100, planExpiresAt: new Date(Date.now() + 86400000) } });
    await prisma.payment.create({ data: { userId: user.id, stripeSessionId: "parent-paid", plan: "PRO", amount: 100, status: "PAID", paidAt: new Date() } });
    const historical = await prisma.videoJob.create({ data: { userId: user.id, inputJson: "{}", status: "processing" } });
    const file = "src/app/api/videos/fetch-stock/route.ts";
    const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file }).outputText;
    const realRequire = createRequire(join(process.cwd(), file));
    const routeModule = { exports: {} as { POST: (r: Request) => Promise<Response> } };
    new Function("require", "module", "exports", compiled)((id: string) => {
      if (id === "@/lib/clerk-auth") return { getCurrentUser: async () => user };
      // Models an authenticated browser/PAT without the server's private service credential.
      if (id === "@/lib/mcp/service-actor") return { isServiceActorRequest: async () => false };
      return realRequire(id.startsWith("@/") ? join(process.cwd(), "src", id.slice(2)) : id);
    }, routeModule, routeModule.exports);
    for (const videoJobId of [historical.id, "foreign-video-id"]) {
      const response = await routeModule.exports.POST(new Request("https://studio.test/api/videos/fetch-stock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keywords: ["fixture"], download: true, stockSource: "kie-image", imageEngine: "runpod", imageModel: "z-image-turbo", videoJobId, parentJobId: historical.id, idempotencyKey: "video:forged-quote-root:scene:0", inputJson: JSON.stringify({ videoJobId: historical.id }), maxAiImages: 99, confirmed: true, fromRenderPipeline: true }) }));
      assert.equal(response.status, 403, await response.clone().text());
      assert.equal((await response.json()).error, "pipeline_only");
    }
    assert.equal(await prisma.aiGenerationJob.count(), 0);
    assert.equal(await prisma.creditLedger.count(), 0);
    console.log("PASS actual fetch-stock HTTP refuses forged body provenance/parent/key before image reservation; ordinary USER, owned historical and foreign IDs");
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(directory, { recursive: true, force: true }));
