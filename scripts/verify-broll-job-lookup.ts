import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Row = { id: string; userId: string; projectId: string; idempotencyKey: string; inputJson: string };
const rows: Row[] = [
  { id: "job-a", userId: "account-a", projectId: "project-a", idempotencyKey: "key-a", inputJson: JSON.stringify({ mode: "broll-rerender", sourceJobId: "source-a", windowEdits: [] }) },
  { id: "job-b", userId: "account-b", projectId: "project-b", idempotencyKey: "key-b", inputJson: JSON.stringify({ mode: "broll-rerender", sourceJobId: "source-b", windowEdits: [] }) },
];
let actor: string | null = "account-a";
const reads: unknown[] = [];
const forbidden = new Proxy({}, { get: (_target, name) => {
  throw new Error(`unexpected write/provider access: ${String(name)}`);
} });

const source = readFileSync("src/app/api/videos/jobs/route.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const route: { GET(request: Request): Promise<Response> } = {} as never;
new Function("require", "exports", compiled)((name: string) => {
  if (name === "next/server") return { NextResponse: { json: (body: unknown, init: { status?: number } = {}) =>
    new Response(JSON.stringify(body), { status: init.status ?? 200 }) } };
  if (name === "@/lib/clerk-auth") return { getCurrentUser: async () => actor ? { id: actor } : null };
  if (name === "@/lib/prisma") return { prisma: { videoJob: {
    findFirst: async (query: { where: { userId: string; idempotencyKey: string }; select: Record<string, boolean> }) => {
      reads.push(query);
      assert.deepEqual(query.select, { id: true, projectId: true, inputJson: true });
      const row = rows.find((item) => item.userId === query.where.userId
        && item.idempotencyKey === query.where.idempotencyKey);
      return row ? { id: row.id, projectId: row.projectId, inputJson: row.inputJson } : null;
    },
    create: forbidden, update: forbidden, updateMany: forbidden, delete: forbidden,
  } } };
  return forbidden;
}, route);

async function get(key: string | null, sourceJobId = "source-a"): Promise<Response> {
  const url = new URL("https://example.test/api/videos/jobs");
  if (key !== null) url.searchParams.set("idempotencyKey", key);
  url.searchParams.set("sourceJobId", sourceJobId);
  return route.GET(new Request(url));
}

async function main() {
  actor = null;
  let response = await get("key-a");
  assert.equal(response.status, 401);
  assert.equal(reads.length, 0, "anonymous requests never query jobs");

  actor = "account-a";
  for (const key of [null, "", "x".repeat(121)]) {
    response = await get(key);
    assert.equal(response.status, 400);
  }
  response = await get("key-a", "x".repeat(121));
  assert.equal(response.status, 400);
  assert.equal(reads.length, 0, "invalid keys never query jobs");

  response = await get("key-b");
  assert.equal(response.status, 404, "another account's key is invisible");
  assert.deepEqual(reads.at(-1), {
    where: { userId: "account-a", idempotencyKey: "key-b" },
    select: { id: true, projectId: true, inputJson: true },
  });

  response = await get("key-a", "unrelated-source");
  assert.equal(response.status, 404, "a matching key for another source cannot be recovered");

  response = await get("key-a");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jobId: "job-a", projectId: "project-a" },
    "recovery returns only the owning job identity and project");
  actor = "account-b";
  response = await get("key-a");
  assert.equal(response.status, 404);
  console.log("PASS: authenticated B-roll lookup is owner scoped, bounded, read only and minimally projected");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
