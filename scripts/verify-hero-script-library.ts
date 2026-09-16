import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "node:http";
import { build } from "esbuild";
import puppeteer from "puppeteer";

const require = createRequire(import.meta.url);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function verifyMountedLibrary() {
  const root = process.cwd();
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ScriptLibrary } from "./src/app/(dashboard)/hero-script/_components/ScriptHistory";
        function Fixture() {
          const [refreshKey, setRefreshKey] = useState(0);
          return <><button id="refresh" onClick={() => setRefreshKey((value) => value + 1)}>refresh</button><ScriptLibrary onOpenScript={() => {}} activeScriptId={null} refreshKey={refreshKey} /></>;
        }
        createRoot(document.getElementById("root")).render(<Fixture />);
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "library-fixture-stubs",
      setup(builder) {
        builder.onResolve(
          { filter: /^(next\/link|@\/lib\/authenticated-fetch|sonner)$/ },
          (args) => ({ path: args.path, namespace: "fixture" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          loader: "tsx",
          resolveDir: root,
          contents: args.path === "next/link"
            ? `export default function Link(props){ return <a {...props} />; }`
            : args.path === "@/lib/authenticated-fetch"
              ? `export const authenticatedFetch = fetch;`
              : `export const toast = { error: () => {}, success: () => {} };`,
        }));
      },
    }],
  });
  const js = bundle.outputFiles[0]!.text;
  const requests: string[] = [];
  let libraryCalls = 0;
  const success = {
    items: [{
      id: "visible-script",
      topic: "Visible fictional topic",
      brandProfileId: null,
      brandName: null,
      durationSec: 60,
      status: "draft",
      editorProjectId: null,
      editorProjectAvailable: false,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    }],
    brandOptions: [{ id: "archived-brand", name: "Archived history brand" }],
    total: 1,
    page: 1,
    pageSize: 20,
    hasNextPage: false,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/app.js") { response.end(js); return; }
    if (url.pathname === "/api/scripts/library") {
      requests.push(url.search);
      libraryCalls += 1;
      if (libraryCalls === 1) { json({ error: "fixture failure" }, 500); return; }
      json(success);
      return;
    }
    if (url.pathname === "/api/brand-profiles") { json([]); return; }
    response.setHeader("Content-Type", "text/html;charset=utf-8");
    response.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => document.body.textContent?.includes("โหลดคลังสคริปต์ไม่สำเร็จ"));
    await page.click("#refresh");
    await page.waitForFunction(() => document.body.textContent?.includes("Visible fictional topic"));
    assert.equal(
      await page.evaluate(() => document.body.textContent?.includes("โหลดคลังสคริปต์ไม่สำเร็จ")),
      false,
      "a successful mounted refresh clears the prior failure alert",
    );
    const brandSelect = await page.$("select");
    assert.ok(brandSelect);
    assert.equal(
      await page.$eval('option[value="archived-brand"]', (option) => option.textContent),
      "Archived history brand",
      "mounted filters include historical brand metadata absent from the visible row",
    );
    const filteredResponse = page.waitForResponse((response) => response.url().includes("brandProfileId=archived-brand"));
    await brandSelect.select("archived-brand");
    await filteredResponse;
    assert.equal(
      requests.some((search) => search.includes("brandProfileId=archived-brand")),
      true,
      "selecting a historical brand issues the full-library brand filter",
    );
    const requestCountBeforeTyping = requests.length;
    const searchedResponse = page.waitForResponse((response) => response.url().includes("q=history"));
    await page.type("#script-library-search", "history");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.length, requestCountBeforeTyping, "mounted search waits for its debounce before requesting");
    await searchedResponse;
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const directory = mkdtempSync(join(tmpdir(), "hero-script-library-"));
process.env.DATABASE_URL = `file:${join(directory, "test.db")}`;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  stdio: "ignore",
  env: process.env,
});

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { listHeroScriptLibrary, parseHeroScriptLibraryQuery } = await import("../src/lib/hero-script-library.server");

  const owner = await prisma.user.create({
    data: { id: "library-owner", name: "Library owner", email: "library-owner@example.test", plan: "PRO" },
  });
  await prisma.user.create({
    data: { id: "foreign-owner", name: "Foreign owner", email: "foreign-owner@example.test", plan: "PRO" },
  });
  await prisma.brandProfile.createMany({ data: [
    { id: "brand-a", userId: owner.id, name: "Fictional Brand A", niche: "education", audience: "creators", tone: "clear" },
    { id: "brand-b", userId: owner.id, name: "Fictional Brand B", niche: "business", audience: "owners", tone: "warm" },
    { id: "archived-brand", userId: owner.id, name: "Archived history brand", niche: "history", audience: "creators", tone: "clear", archivedAt: new Date("2026-09-16T00:00:00.000Z") },
    { id: "foreign-brand", userId: "foreign-owner", name: "Foreign Brand", niche: "private", audience: "private", tone: "private" },
  ] });
  await prisma.editorProject.createMany({ data: [
    { id: "owned-project", userId: owner.id, title: "Owned fictional project" },
    { id: "foreign-project", userId: "foreign-owner", title: "Foreign fictional project" },
  ] });
  const fixedTime = new Date("2026-09-17T00:00:00.000Z");

  await prisma.script.createMany({
    data: Array.from({ length: 500 }, (_, index) => ({
      id: `owned-${String(index + 1).padStart(4, "0")}`,
      userId: owner.id,
      topic: index === 41 ? "Fictional needle topic" : `Fictional library topic ${index + 1}`,
      durationSec: ([30, 60, 90] as const)[index % 3],
      hookText: `Hook fixture ${index + 1}`,
      bodyText: `Body fixture ${index + 1}`,
      ctaText: `CTA fixture ${index + 1}`,
      status: index % 2 === 0 ? "draft" : "sent",
      brandProfileId: index === 41 ? "archived-brand" : index % 3 === 0 ? null : index % 3 === 1 ? "brand-a" : "brand-b",
      editorProjectId: index === 499 ? "owned-project" : index === 497 ? "foreign-project" : null,
      createdAt: fixedTime,
      updatedAt: fixedTime,
    })),
  });
  await prisma.script.create({
    data: {
      id: "foreign-script",
      userId: "foreign-owner",
      topic: "Fictional needle foreign",
      hookText: "Foreign hook fixture",
      bodyText: "Foreign body fixture",
      ctaText: "Foreign CTA fixture",
      brandProfileId: "foreign-brand",
      editorProjectId: "foreign-project",
      updatedAt: fixedTime,
    },
  });

  const defaultPage = await listHeroScriptLibrary(owner.id, {
    q: "",
    status: "all",
    brandProfileId: null,
    page: 1,
    pageSize: 20,
  });
  assert.equal(
    defaultPage.items.some((item) => item.brandProfileId === "archived-brand"),
    false,
    "the archived brand's only script is outside the visible first page fixture",
  );
  assert.deepEqual(
    defaultPage.brandOptions.find((option) => option.id === "archived-brand"),
    { id: "archived-brand", name: "Archived history brand" },
    "the first response still supplies the historical brand filter metadata",
  );

  const result = await listHeroScriptLibrary(owner.id, {
    q: "needle",
    status: "all",
    brandProfileId: null,
    page: 1,
    pageSize: 20,
  });
  assert.equal(result.total, 1, "whole-library search finds the owned row beyond the former 50-row cap");
  assert.deepEqual(result.items.map((item) => item.id), ["owned-0042"]);
  assert.equal(Object.hasOwn(result.items[0]!, "bodyText"), false, "library summaries exclude full script body text");
  assert.deepEqual(
    result.brandOptions.find((option) => option.id === "archived-brand"),
    { id: "archived-brand", name: "Archived history brand" },
    "an archived owned brand remains discoverable even when its script is beyond the visible default page",
  );
  assert.equal(
    result.brandOptions.some((option) => option.id === "foreign-brand"),
    false,
    "foreign brand metadata never enters the owner's filter options",
  );

  const sentBrandA = await listHeroScriptLibrary(owner.id, {
    q: "",
    status: "sent",
    brandProfileId: "brand-a",
    page: 2,
    pageSize: 7,
  });
  assert.equal(sentBrandA.total, 84, "combined status and owned-brand filters use the same predicates for rows and count");
  assert.deepEqual(
    sentBrandA.items.map((item) => item.id),
    ["owned-0458", "owned-0452", "owned-0446", "owned-0440", "owned-0434", "owned-0428", "owned-0422"],
    "equal timestamps paginate stably by id DESC",
  );
  assert.equal(sentBrandA.hasNextPage, true);

  const noBrandDrafts = await listHeroScriptLibrary(owner.id, {
    q: "",
    status: "draft",
    brandProfileId: "none",
    page: 5,
    pageSize: 20,
  });
  assert.equal(noBrandDrafts.total, 84, "the explicit no-brand filter combines with status");
  assert.deepEqual(noBrandDrafts.items.map((item) => item.id), ["owned-0019", "owned-0013", "owned-0007", "owned-0001"]);
  assert.equal(noBrandDrafts.hasNextPage, false);

  const foreignBrand = await listHeroScriptLibrary(owner.id, {
    q: "",
    status: "all",
    brandProfileId: "foreign-brand",
    page: 1,
    pageSize: 20,
  });
  assert.equal(foreignBrand.total, 0, "a foreign brand filter cannot reveal whether the profile exists");

  const finalPage = await listHeroScriptLibrary(owner.id, {
    q: "",
    status: "all",
    brandProfileId: null,
    page: 25,
    pageSize: 20,
  });
  assert.equal(finalPage.total, 500, "foreign scripts never enter owned totals");
  assert.equal(finalPage.items.length, 20, "all 500 owned summaries are page-accessible");
  assert.equal(finalPage.hasNextPage, false);
  const pagedIds = new Set<string>();
  for (let currentPage = 1; currentPage <= 25; currentPage += 1) {
    const current = await listHeroScriptLibrary(owner.id, {
      q: "",
      status: "all",
      brandProfileId: null,
      page: currentPage,
      pageSize: 20,
    });
    for (const item of current.items) pagedIds.add(item.id);
  }
  assert.equal(pagedIds.size, 500, "stable pagination reaches each owned fixture exactly once");
  assert.equal(pagedIds.has("foreign-script"), false, "foreign rows never appear on any owned page");
  const projectLinks = await listHeroScriptLibrary(owner.id, {
    q: "topic 498",
    status: "all",
    brandProfileId: null,
    page: 1,
    pageSize: 20,
  });
  const foreignProjectLink = projectLinks.items.find((item) => item.id === "owned-0498");
  assert.equal(foreignProjectLink?.editorProjectId, null, "a foreign project identity is not exposed");
  assert.equal(foreignProjectLink?.editorProjectAvailable, false);
  const ownedProjectLink = await listHeroScriptLibrary(owner.id, {
    q: "topic 500",
    status: "all",
    brandProfileId: null,
    page: 1,
    pageSize: 20,
  });
  assert.equal(ownedProjectLink.items[0]?.editorProjectId, "owned-project");
  assert.equal(ownedProjectLink.items[0]?.editorProjectAvailable, true, "an owned linked project remains available");

  assert.deepEqual(
    parseHeroScriptLibraryQuery(new URL("https://example.test/api/scripts/library?q=%20needle%20&status=sent&page=2&pageSize=7").searchParams),
    { ok: true, query: { q: "needle", status: "sent", brandProfileId: null, page: 2, pageSize: 7 } },
    "query parsing trims search and applies explicit pagination",
  );
  for (const search of [
    "status=deleted",
    "page=0",
    "page=-1",
    "page=1.5",
    "pageSize=0",
    "pageSize=21",
    `q=${"x".repeat(201)}`,
    "brandProfileId=",
    "page=9007199254740991",
    "status=all&status=sent",
  ]) {
    assert.equal(
      parseHeroScriptLibraryQuery(new URL(`https://example.test/api/scripts/library?${search}`).searchParams).ok,
      false,
      `invalid library query is rejected: ${search.slice(0, 40)}`,
    );
  }

  let actingUserId: string | null = null;
  const clerkAuthModuleId = require.resolve("../src/lib/clerk-auth");
  require.cache[clerkAuthModuleId] = {
    id: clerkAuthModuleId,
    filename: clerkAuthModuleId,
    loaded: true,
    exports: {
      getCurrentUser: async () => actingUserId
        ? prisma.user.findUnique({ where: { id: actingUserId } })
        : null,
    },
  } as never;
  const libraryRoute = await import("../src/app/api/scripts/library/route");

  actingUserId = null;
  const anonymous = await libraryRoute.GET(new Request(`https://example.test/api/scripts/library?q=${"x".repeat(201)}`));
  assert.equal(anonymous.status, 401, "authentication runs before query validation or library reads");

  actingUserId = "foreign-owner";
  const locked = await libraryRoute.GET(new Request("https://example.test/api/scripts/library"));
  assert.equal(locked.status, 403, "the existing Hero Script feature gate remains in front of library reads");

  await prisma.user.update({ where: { id: owner.id }, data: { role: "ADMIN" } });
  actingUserId = owner.id;
  const invalid = await libraryRoute.GET(new Request("https://example.test/api/scripts/library?pageSize=21"));
  assert.equal(invalid.status, 400, "invalid authenticated queries return 400");
  const duplicate = await libraryRoute.GET(new Request("https://example.test/api/scripts/library?status=all&status=sent"));
  assert.equal(duplicate.status, 400, "duplicate singleton parameters are rejected instead of ambiguously widened");

  const scriptCountBeforeGet = await prisma.script.count();
  const projectCountBeforeGet = await prisma.editorProject.count();
  const apiResult = await libraryRoute.GET(new Request("https://example.test/api/scripts/library?q=needle"));
  assert.equal(apiResult.status, 200);
  const apiPayload = await apiResult.json() as { items: Array<Record<string, unknown>>; brandOptions: Array<{ id: string; name: string }>; total: number };
  assert.equal(apiPayload.total, 1, "the route returns the owner-scoped service result");
  assert.deepEqual(Object.keys(apiPayload.items[0]!).sort(), [
    "brandName", "brandProfileId", "createdAt", "durationSec", "editorProjectAvailable",
    "editorProjectId", "id", "status", "topic", "updatedAt",
  ], "the HTTP list payload contains bounded summary metadata only");
  assert.deepEqual(apiPayload.brandOptions.find((option) => option.id === "archived-brand"), {
    id: "archived-brand",
    name: "Archived history brand",
  });
  assert.equal(await prisma.script.count(), scriptCountBeforeGet, "library GET does not write Script rows");
  assert.equal(await prisma.editorProject.count(), projectCountBeforeGet, "library GET does not create Editor projects");

  const {
    ScriptLibrary,
    loadLatestScriptLibraryPage,
  } = await import("../src/app/(dashboard)/hero-script/_components/ScriptHistory");
  const olderResponse = deferred<Response>();
  const newerResponse = deferred<Response>();
  const latestRequest = { current: 0 };
  const requestedUrls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    return url.includes("q=older") ? olderResponse.promise : newerResponse.promise;
  };
  const olderRequest = loadLatestScriptLibraryPage(
    { q: "older", status: "all", brandProfileId: null, page: 3, pageSize: 20 },
    latestRequest,
    fetcher,
  );
  const newerRequest = loadLatestScriptLibraryPage(
    { q: "newer", status: "sent", brandProfileId: "none", page: 1, pageSize: 20 },
    latestRequest,
    fetcher,
  );
  newerResponse.resolve(Response.json({ items: [{ id: "newer-result" }], brandOptions: [], total: 1, page: 1, pageSize: 20, hasNextPage: false }));
  const newerOutcome = await newerRequest;
  olderResponse.resolve(Response.json({ items: [{ id: "older-result" }], brandOptions: [], total: 1, page: 3, pageSize: 20, hasNextPage: false }));
  const olderOutcome = await olderRequest;
  assert.equal(newerOutcome.status, "applied", "the newest query response is eligible to update the library");
  assert.equal(olderOutcome.status, "stale", "an older response cannot overwrite newer query/filter results");
  assert.match(requestedUrls[1]!, /q=newer/);
  assert.match(requestedUrls[1]!, /status=sent/);
  assert.match(requestedUrls[1]!, /brandProfileId=none/);

  const staleFailure = deferred<Response>();
  const succeedingResponse = deferred<Response>();
  const failureCounter = { current: 0 };
  const oldFailure = loadLatestScriptLibraryPage(
    { q: "old-failure", status: "all", brandProfileId: null, page: 1, pageSize: 20 },
    failureCounter,
    async () => staleFailure.promise,
  );
  const newSuccess = loadLatestScriptLibraryPage(
    { q: "new-success", status: "all", brandProfileId: null, page: 1, pageSize: 20 },
    failureCounter,
    async () => succeedingResponse.promise,
  );
  succeedingResponse.resolve(Response.json({ items: [], brandOptions: [], total: 0, page: 1, pageSize: 20, hasNextPage: false }));
  assert.equal((await newSuccess).status, "applied");
  staleFailure.resolve(Response.json({ error: "old failure" }, { status: 500 }));
  assert.equal((await oldFailure).status, "stale", "an older failure cannot replace the newer successful state");

  const initialMarkup = renderToStaticMarkup(createElement(ScriptLibrary, {
    onOpenScript: () => {},
    activeScriptId: null,
    refreshKey: 0,
  }));
  assert.match(initialMarkup, /ค้นหาสคริปต์/, "the isolated library exposes a labelled search control");
  assert.match(initialMarkup, /ทุกแบรนด์/, "the isolated library exposes the brand filter");
  assert.match(initialMarkup, /กำลังโหลด/, "initial loading is distinct from an empty library");

  await verifyMountedLibrary();

  await prisma.$disconnect();
  console.log("verify-hero-script-library: PASS whole-library search, historical filters, and mounted refresh recovery");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
