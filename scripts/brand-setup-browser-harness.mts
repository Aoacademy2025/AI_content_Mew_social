/** Local, isolated browser fixture for the REAL /brands client. All APIs are
 * in-memory fixtures; no authentication, production data or paid services. */
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { createBlankBrandProfileSeed } from "../src/lib/brand-profile-seed";
import { createBrandSetupSeed } from "../src/lib/brand-setup";
import { activeStylePacks } from "../src/lib/style-pack-catalog";
import { VISUAL_FORMATS } from "../src/lib/brand-visual-system";

const root = process.cwd();
const output = resolve("artifacts/brands-ux-browser"); mkdirSync(output, { recursive: true });
const seed = createBlankBrandProfileSeed();
const defaults = { script: { styleId: null, tone: seed.script.tone, analysisNotes: null, sampleText: null }, voice: { provider: "gemini" as const, voiceId: "Kore" }, subtitle: { presetId: null, config: {} }, brandMark: seed.brandMark };
const profiles: any[] = [];
const results = new Map<string, unknown>();
let failOnce = process.argv.includes("--failure-once");
const library = () => ({ profiles, cap: 5, canCreate: profiles.length < 5, availabilitySelectionRequired: false, imageAccess: { canUse: false, reason: "payment_required", upgradeUrl: "/pricing" }, defaults, stylePacks: activeStylePacks().map(p => ({ ...p, sampleImage: `/style-packs/${p.id}.jpg` })), visualFormats: VISUAL_FORMATS.map(f => ({ ...f, previewUrl: `/brand-visual-formats/${f.id}.webp` })), treatmentPresets: [], subtitlePresets: [], brandAssets: [] });
const bundled = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrandLibraryClient} from './src/app/(dashboard)/brands/_components/BrandLibraryClient'; createRoot(document.getElementById('root')).render(<div className="fixture-shell"><header className="fixture-header">LOCAL FIXTURE · APIs จำลอง · ไม่ใช้ข้อมูลจริงหรือเครดิต</header><main className="fixture-main"><BrandLibraryClient/></main><nav className="fixture-tabs">พื้นที่เมนูหลักบนมือถือ</nav></div>);`, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "isolated-browser-boundaries", setup(b) {
    b.onResolve({ filter: /^(next\/navigation|next\/link|@\/lib\/use-me)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "tsx", resolveDir: root, contents:
      args.path === "next/link" ? `import React from 'react'; export default function Link(props){return <a {...props}/>}` : args.path === "next/navigation" ? `export function useRouter(){return {push:(url)=>window.location.assign(url)}}` : `export async function fetchMe(){return {id:'fixture-user',plan:'FREE'}}` }));
  } }],
});
const js = bundled.outputFiles[0].text;
writeFileSync(join(output, "app.js"), js);
const candidates = new Set<string>();
// Scan the same source classes Tailwind sees, plus rendered branch strings.
function scan(dir: string) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) scan(file); else if (/\.(tsx?|css)$/.test(file)) for (const token of readFileSync(file, "utf8").match(/[^\s"'`<>]+/g) ?? []) candidates.add(token); } }
scan(join(root, "src/app/(dashboard)/brands")); scan(join(root, "src/components/ui"));
const css = (await compile(readFileSync("src/app/globals.css", "utf8"), { base: root, onDependency() {} })).build([...candidates]);
const html = `<!doctype html><html lang="th" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} .fixture-shell{display:flex;flex-direction:column;height:100dvh;overflow:hidden}.fixture-header{padding:8px 20px;font-size:12px;flex-shrink:0}.fixture-main{display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden;padding-bottom:64px}.fixture-tabs{position:fixed;bottom:0;left:0;right:0;height:56px;padding:16px;background:#111;text-align:center;font-size:12px}@media(min-width:1024px){.fixture-main{padding-bottom:0}.fixture-tabs{display:none}}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
writeFileSync(join(output, "index.html"), html);
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(js); return; }
  if (url.pathname.startsWith("/style-packs/") || url.pathname.startsWith("/brand-visual-formats/")) {
    if (!/^\/(style-packs|brand-visual-formats)\/(?:[0-9-]+\/)?[a-z-]+\.(jpg|webp)$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader("Content-Type", url.pathname.endsWith(".jpg") ? "image/jpeg" : "image/webp"); res.end(readFileSync(join(root, "public", url.pathname))); } catch { res.writeHead(404); res.end(); } return;
  }
  if (url.pathname === "/api/brand-library" && req.method === "GET") return json(library());
  if (url.pathname === "/api/telemetry") return json({ ok: true });
  if (url.pathname === "/api/brand-library/setup") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    let result = results.get(body.requestId);
    if (!result) {
      let profile = profiles.find(p => p.id === body.profileId);
      if (!profile) { const payload = body.payload ?? createBrandSetupSeed(defaults, []); profile = { id: `fixture-brand-${profiles.length + 1}`, ...payload, tone: payload.script.tone, bannedWords: [], language: "th", frozen: false, legacyVisualFormat: false, activeRevisionNumber: 1, updatedAt: new Date().toISOString(), draft: { baseRevisionNumber: 1, payload }, revisions: [{ id: `fixture-revision-${profiles.length + 1}`, version: 1, payload, createdAt: new Date().toISOString() }] }; profiles.push(profile); }
      else if (body.action !== "use-brand") {
        profile.activeRevisionNumber += 1; profile.name = body.payload.name;
        profile.draft = { baseRevisionNumber: profile.activeRevisionNumber, payload: body.payload };
        profile.revisions.unshift({ id: `${profile.id}-revision-${profile.activeRevisionNumber}`, version: profile.activeRevisionNumber, payload: body.payload, createdAt: new Date().toISOString() });
      }
      result = { profileId: profile.id, revisionId: profile.revisions[0].id, revision: profile.activeRevisionNumber, projectId: body.action === "save" ? null : `fixture-project-${results.size + 1}` }; results.set(body.requestId, result);
      if (failOnce) { failOnce = false; return json({ error: "จำลอง: บันทึกสำเร็จแล้ว แต่การเชื่อมต่อขาด ติดตามคำขอเดิมได้" }, 503); }
    }
    return json(result);
  }
  if (url.pathname === "/video-editor") { res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(`<h1>ส่งถึง editor จำลองแล้ว</h1><p>โปรเจกต์: ${url.searchParams.get("projectId")?.replace(/[^a-z0-9-]/gi, "")}</p><a href="/brands">กลับคลังแบรนด์</a>`); return; }
  if (url.pathname.startsWith("/api/")) return json({ error: "fixture endpoint unavailable" }, 404);
  res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(html);
});
const port = Number(process.env.BRAND_SETUP_FIXTURE_PORT || 8771);
server.listen(port, "127.0.0.1", () => console.log(`Brand setup fixture: http://127.0.0.1:${port}/brands${failOnce ? " (first save response fails after commit)" : ""}`));
