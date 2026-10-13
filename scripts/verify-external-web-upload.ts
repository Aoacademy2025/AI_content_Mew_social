/** Native upload metadata boundary: real HTTP route/auth owner/validation/admission + DB;
 * normalization is stubbed here (real ffmpeg is covered by verify-mcp-external-media). */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import ts from "typescript";
const dir = mkdtempSync(join(tmpdir(), "external-web-upload-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.NEXT_PUBLIC_BROLL_WINDOW_EDIT = "1";
execFileSync("./node_modules/.bin/prisma", ["db", "push", "--skip-generate"], { stdio: "pipe", env: process.env });
async function main() {
  const req = createRequire(join(process.cwd(), "scripts/verify-external-web-upload.ts"));
  const { prisma } = await import("../src/lib/prisma");
  const pipeline = await import("../src/lib/media-import/broll-pipeline");
  const user = await prisma.user.create({ data: { email: "web-upload@example.test", name: "Uploader", plan: "PRO" } });
  let valid = true;
  let pipelineCalls = 0;
  const file = "src/app/api/videos/broll-window/upload/route.ts";
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file }).outputText;
  const routeModule = { exports: {} as { POST: (r: Request) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "@/lib/clerk-auth") return { getCurrentUser: async () => user };
    if (id === "@/lib/media-import/broll-pipeline") return { ...pipeline, runBrollPipeline: async () => {
      pipelineCalls++;
      return valid ? { ok: true, value: { src: "/api/stocks/server-normalized.mp4", clipDuration: 5, stillImage: true } }
        : { ok: false, value: { error: "process_failed", message: "cannot normalize", status: 502 } };
    } };
    return req(id.startsWith("@/") ? join(process.cwd(), "src", id.slice(2)) : id);
  }, routeModule, routeModule.exports);
  function request(type = "image/png", name = "image.png") {
    const data = new FormData(); data.append("file", new File([new Uint8Array([1, 2, 3])], name, { type }));
    data.append("src", "/api/stocks/foreign.mp4"); data.append("userId", "foreign"); data.append("status", "ready");
    return new Request("https://studio.test/api/videos/broll-window/upload", { method: "POST", body: data });
  }
  const invalid = await routeModule.exports.POST(request("text/plain", "input.txt"));
  assert.equal(invalid.status, 415); assert.equal(pipelineCalls, 0); assert.equal(await prisma.mediaImport.count(), 0);
  valid = false;
  const failure = await routeModule.exports.POST(request()); assert.equal(failure.status, 502); assert.equal(await prisma.mediaImport.count(), 0);
  valid = true;
  const success = await routeModule.exports.POST(request()); assert.equal(success.status, 200);
  const owned = await prisma.mediaImport.findFirstOrThrow();
  assert.equal(owned.userId, user.id); assert.equal(owned.status, "ready"); assert.equal(owned.purpose, "broll_image");
  assert.equal(owned.resultSrc, "/api/stocks/server-normalized.mp4"); assert.equal(owned.durationMs, 5000); assert.equal(owned.bytes, 3);
  assert.equal(await prisma.mediaImport.count({ where: { resultSrc: "/api/stocks/foreign.mp4" } }), 0);
  console.log("PASS native upload: validation/admission retained; only successful server-normalized output mints owner-scoped ready identity; hostile form fields ignored");
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => rmSync(dir, { recursive: true, force: true }));
