"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Loader2, Plus, Copy, Trash2, Terminal, Check, ArrowRight, Sparkles, Code2, Bot, Zap, KeyRound,
  ListChecks, RefreshCw, Puzzle, PlayCircle, Crown,
} from "lucide-react";
import { toast } from "sonner";
import { trackEvent } from "@/lib/client-telemetry";
import { computeKeyStatus, planKeySetupChecklist } from "@/lib/key-tiers";
import {
  MCP_ENDPOINT_URL,
  MCP_TOKEN_PLACEHOLDER,
  MCP_CREATOR_PROMPT_TEMPLATES,
  buildClaudeCodeCommand,
  buildClaudeDesktopConfigJson,
  buildCursorMcpConfigJson,
} from "@/lib/mcp/creator-prompt-pack";

type TokenRow = { id: string; name: string | null; lastUsedAt: string | null; createdAt: string; expiresAt: string | null };
type StarterTrialSummary = {
  eligible: boolean;
  isStarterTrialPlan: boolean;
  usedClips: number;
  limitClips: number;
  remainingClips: number;
  maxDurationSeconds: number;
  upgradeUrl: string;
};

const MCP_URL = MCP_ENDPOINT_URL;
const TOKEN_PLACEHOLDER = MCP_TOKEN_PLACEHOLDER;

function copyText(value: string, label: string, telemetry?: { event: string; properties?: Record<string, string | number | boolean | null> }) {
  navigator.clipboard
    .writeText(value)
    .then(() => {
      toast.success(`คัดลอก${label}แล้ว`);
      if (telemetry) {
        trackEvent(telemetry.event, { properties: telemetry.properties });
      }
    })
    .catch(() => toast.error("คัดลอกไม่สำเร็จ"));
}

type ClientId = "claude-cowork" | "claude-desktop-json" | "cursor" | "claude-code" | "codex" | "openclaw" | "hermes" | "other-mcp";
type ClientGroup = "login" | "token";

type ClientDef = {
  id: ClientId;
  label: string;
  group: ClientGroup;
  icon: React.ElementType;
  blurb: string;
  needsToken: boolean;
  steps: string[];
  code?: (token: string) => string;
};

const CLIENTS: ClientDef[] = [
  {
    id: "claude-cowork",
    label: "Claude (cowork / Desktop / Web)",
    group: "login",
    icon: Sparkles,
    blurb: "ง่ายสุด — เชื่อมผ่าน Login ไม่ต้องสร้าง/ก๊อป token",
    needsToken: false,
    steps: [
      "เปิด Claude → Settings → Connectors → “Add custom connector”",
      `วาง Endpoint URL ด้านบน (${MCP_URL})`,
      "กด Connect แล้ว Login ด้วยบัญชี HERO AI (OAuth) — เสร็จ",
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code (CLI)",
    group: "token",
    icon: Terminal,
    blurb: "สั่งจาก terminal — คำสั่งเดียวจบ",
    needsToken: true,
    steps: ["รันคำสั่งนี้ใน terminal (วาง token ของคุณแทน)"],
    code: (t) => buildClaudeCodeCommand(t),
  },
  {
    id: "cursor",
    label: "Cursor (.cursor/mcp.json)",
    group: "token",
    icon: Code2,
    blurb: "1-Click Copy สำหรับ Cursor MCP config",
    needsToken: true,
    steps: ["วาง JSON นี้ใน .cursor/mcp.json หรือ Cursor Settings → MCP"],
    code: (t) => buildCursorMcpConfigJson(t),
  },
  {
    id: "claude-desktop-json",
    label: "Claude Desktop (JSON)",
    group: "token",
    icon: Sparkles,
    blurb: "ตั้งค่าผ่านไฟล์ claude_desktop_config.json ด้วย Token",
    needsToken: true,
    steps: ["วาง JSON นี้ใน claude_desktop_config.json แล้วรีสตาร์ทแอป Claude"],
    code: (t) => buildClaudeDesktopConfigJson(t),
  },
  {
    id: "codex",
    label: "Codex (CLI)",
    group: "token",
    icon: Code2,
    blurb: "OpenAI Codex — token อ่านจาก environment variable",
    needsToken: true,
    steps: ["เพิ่ม server แล้วตั้ง env var ให้ token"],
    code: (t) => `codex mcp add heroai --url ${MCP_URL} \\
  --bearer-token-env-var HEROAI_TOKEN
export HEROAI_TOKEN="${t}"`,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    group: "token",
    icon: Bot,
    blurb: "Agent อัตโนมัติ — เพิ่มผ่าน CLI คำสั่งเดียว",
    needsToken: true,
    steps: ["รันคำสั่งนี้ (วาง token ของคุณแทน)"],
    code: (t) => `openclaw mcp add heroai --url ${MCP_URL} \\
  --transport streamable-http --header "Authorization: Bearer ${t}"`,
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    group: "token",
    icon: Zap,
    blurb: "Nous Research — เพิ่มในไฟล์ config",
    needsToken: true,
    steps: ["แก้ไฟล์ ~/.hermes/config.yaml เพิ่มบล็อกนี้ แล้วรีสตาร์ท Hermes"],
    code: (t) => `# ~/.hermes/config.yaml
mcp_servers:
  heroai:
    url: "${MCP_URL}"
    headers:
      Authorization: "Bearer ${t}"`,
  },
  {
    id: "other-mcp",
    label: "AI อื่นที่รองรับ MCP",
    group: "token",
    icon: Puzzle,
    blurb: "Grok, Dot, Muse AI หรือ agent ไหนก็ได้ที่คุยผ่าน MCP (streamable HTTP)",
    needsToken: true,
    steps: [
      "เพิ่ม MCP server แบบ streamable HTTP โดยใช้ Endpoint ด้านบน",
      "ใส่ header Authorization: Bearer <token> ของคุณ (ดูวิธีตั้งค่าเฉพาะใน docs ของ AI ตัวนั้น)",
    ],
    code: (t) => `Endpoint: ${MCP_URL}
Transport: streamable HTTP
Header: Authorization: Bearer ${t}`,
  },
];

const GROUP_LABEL: Record<ClientGroup, string> = {
  login: "เชื่อมด้วยการ Login (ไม่ต้องใช้ Token)",
  token: "เชื่อมด้วย Token (1-Click Copy)",
};

function ClientPanel({ client, token }: { client: ClientDef; token: string }) {
  const usingPlaceholder = token === TOKEN_PLACEHOLDER;
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-3">
      <div>
        <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>{client.label}</p>
        <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>{client.blurb}</p>
      </div>

      <ol className="space-y-1.5">
        {client.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-xs" style={{ color: "var(--ui-text-secondary)" }}>
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-violet-300"
              style={{ background: "hsl(var(--accent-primary) / 0.15)" }}>{i + 1}</span>
            <span className="leading-relaxed">{s}</span>
          </li>
        ))}
      </ol>

      {client.code && (
        <div className="relative">
          <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 pr-10 text-[11px] leading-relaxed text-zinc-300">{client.code(token)}</pre>
          <button onClick={() => copyText(client.code!(token), "การตั้งค่า")} title="คัดลอก"
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white">
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {client.needsToken && usingPlaceholder && (
        <p className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--ui-text-muted)" }}>
          <KeyRound className="h-3 w-3 text-amber-300" /> แทน <code className="text-amber-300">{TOKEN_PLACEHOLDER}</code> ด้วยคีย์จากขั้นตอนที่ 2 ด้านล่าง
        </p>
      )}
      {!client.needsToken && (
        <p className="text-[11px] flex items-center gap-1.5 text-emerald-300/80">
          <Check className="h-3 w-3" /> ไม่ต้องใช้ token — เชื่อมผ่าน Login (OAuth)
        </p>
      )}
    </div>
  );
}

function ConnectGuide({ token }: { token: string }) {
  const [active, setActive] = useState<ClientId>("claude-cowork");
  const client = CLIENTS.find((c) => c.id === active)!;
  const groups: ClientGroup[] = ["login", "token"];

  return (
    <div className="space-y-3">
      {/* Endpoint + 1-click quick copy bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-black/30 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--ui-text-muted)" }}>Endpoint</span>
        <code className="flex-1 min-w-0 truncate text-xs text-violet-300">{MCP_URL}</code>
        <button onClick={() => copyText(MCP_URL, "Endpoint", { event: "mcp_config_copied", properties: { target: "endpoint" } })} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/10 hover:text-white">
          <Copy className="h-3 w-3" /> คัดลอก URL
        </button>
        <button onClick={() => copyText(buildClaudeDesktopConfigJson(token), " Claude Desktop JSON", { event: "mcp_config_copied", properties: { target: "claude_desktop_json" } })} className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-violet-200 transition-colors hover:bg-white/10">
          <Copy className="h-3 w-3" /> Claude Desktop JSON
        </button>
        <button onClick={() => copyText(buildCursorMcpConfigJson(token), " Cursor MCP JSON", { event: "mcp_config_copied", properties: { target: "cursor_json" } })} className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-violet-200 transition-colors hover:bg-white/10">
          <Copy className="h-3 w-3" /> Cursor JSON
        </button>
        <button onClick={() => copyText(buildClaudeCodeCommand(token), "คำสั่ง Claude Code", { event: "mcp_config_copied", properties: { target: "claude_code_cli" } })} className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-violet-200 transition-colors hover:bg-white/10">
          <Copy className="h-3 w-3" /> Claude Code CLI
        </button>
      </div>

      {/* Picker — grouped pills */}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g} className="flex flex-wrap items-center gap-2">
            <span className="w-full text-[11px] font-semibold sm:w-auto sm:shrink-0" style={{ color: "var(--ui-text-muted)" }}>{GROUP_LABEL[g]}</span>
            {CLIENTS.filter((c) => c.group === g).map((c) => {
              const Icon = c.icon;
              const on = active === c.id;
              return (
                <button key={c.id} onClick={() => setActive(c.id)}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all"
                  style={on ? {
                    background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))",
                    color: "#fff",
                    boxShadow: "0 4px 12px hsl(var(--accent-primary) / 0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
                  } : {
                    background: "hsl(0 0% 100% / 0.04)",
                    border: "1px solid hsl(0 0% 100% / 0.08)",
                    color: "var(--ui-text-muted)",
                  }}>
                  <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
                  {c.label.split(" (")[0]}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <ClientPanel client={client} token={token} />
    </div>
  );
}

export function McpAccessSettings({ allowed }: { allowed: boolean }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [starterTrial, setStarterTrial] = useState<StarterTrialSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [managed, setManaged] = useState(false);
  const [managedStock, setManagedStock] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{ gemini: boolean; pexels: boolean; pixabay: boolean } | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/mcp-tokens")
      .then((r) => r.json())
      .then((d) => {
        setTokens(Array.isArray(d.tokens) ? d.tokens : []);
        if (d.starterTrial) setStarterTrial(d.starterTrial);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, [allowed]);

  useEffect(() => {
    fetch("/api/user/api-keys/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.managed) setManaged(true); if (d?.managedStock) setManagedStock(true); })
      .catch(() => {});
    fetch("/api/user/api-keys", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setKeyStatus({ gemini: !!d.geminiKey?.set, pexels: !!d.pexelsKey?.set, pixabay: !!d.pixabayKey?.set });
      })
      .catch(() => {});
  }, []);

  async function createToken() {
    setCreating(true);
    try {
      const res = await fetch("/api/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "สร้าง token ไม่สำเร็จ"); return; }
      setNewToken(data.token);
      setName("");
      load();
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    try {
      const res = await fetch(`/api/mcp-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) { toast.error("เพิกถอนไม่สำเร็จ"); return; }
      toast.success("เพิกถอน token แล้ว");
      setTokens((t) => t.filter((x) => x.id !== id));
    } catch {
      toast.error("เกิดข้อผิดพลาด");
    } finally {
      setRevoking(null);
    }
  }

  const setupNote = (() => {
    if (!keyStatus) return null;
    const status = computeKeyStatus({ gemini: keyStatus.gemini, pexels: keyStatus.pexels, pixabay: keyStatus.pixabay }, managed);
    const checklist = planKeySetupChecklist({ status, managedGemini: managed, managedStock });
    if (!checklist.render) {
      return { ok: true, text: "ไม่ต้องตั้งคีย์ก็สั่งได้ ใส่ ElevenLabs / HeyGen ที่แท็บคีย์เชื่อมต่อเฉพาะถ้าจะใช้เสียงโคลนหรือพิธีกร AI" };
    }
    const missing: string[] = [];
    if (checklist.geminiRequired && !status.gemini) missing.push("Gemini key");
    if (checklist.stockRequired && !checklist.stockDone) missing.push("Pexels หรือ Pixabay key");
    return { ok: false, text: `ยังขาด ${missing.join(" และ ")} — ตั้งที่แท็บคีย์เชื่อมต่อก่อนถึงจะสั่งสร้างวิดีโอได้` };
  })();

  return (
    <div className="space-y-5">
      {/* Starter Trial banner for FREE users */}
      {!allowed && (
        <div
          className="rounded-xl p-4 space-y-2"
          style={{
            background: "linear-gradient(135deg, hsl(var(--accent-primary) / 0.14), hsl(var(--accent-secondary) / 0.08))",
            border: "1px solid hsl(var(--accent-primary) / 0.3)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-amber-300" strokeWidth={2.25} />
              <p className="text-sm font-bold" style={{ color: "var(--ui-text-primary)" }}>
                สิทธิ์ทดลอง MCP ฟรี 1 คลิปแรก (Starter Trial)
              </p>
            </div>
            {starterTrial && (
              <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-violet-200">
                คงเหลือ {starterTrial.remainingClips}/{starterTrial.limitClips} คลิป
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
            บัญชี FREE สามารถสร้าง Token และลองสั่ง AI Agent สร้างคลิปสั้นได้ฟรี 1 คลิป (เสียงพากย์ Gemini + Stock B-roll ความยาวไม่เกิน 3 นาที โดยไม่ใช้เครดิต) — หากต้องการสร้างเพิ่ม ใช้ Hero AI Image, เสียง ElevenLabs, Avatar หรือสั่งแก้ซับ/B-roll ก่อนส่งออก อัปเกรดเป็น PRO หรือ BUSINESS ได้ทันที
          </p>
          <a
            href="/pricing"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-300 hover:underline"
          >
            ดูแพ็กเกจ PRO / BUSINESS <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {/* สั่งอะไรได้บ้าง */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4">
        <div className="flex items-center gap-2 mb-2">
          <ListChecks className="h-4 w-4 text-violet-400" strokeWidth={2.25} />
          <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>สั่งอะไรได้บ้าง</p>
        </div>
        <ul className="space-y-1 text-xs leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
          <li>• สร้างคลิปจากสคริปต์ — เสียงพากย์ + B-roll เปลี่ยนทุก 3–5 วิ + ซับไทย + พิธีกร AI (ถ้าต้องการ)</li>
          <li>• เลือก Style Pack สำเร็จรูป (ข่าวด่วน, รีวิวสินค้า, จัดอันดับ, การเงิน, เรื่องหลอน) ได้ทันที</li>
          <li>• แก้ก่อนส่งออก ไม่ตัดโควต้าเพิ่ม — แก้ซับ เพลง พาดหัว B-roll ได้ก่อนส่งออกจริง (PRO / BUSINESS)</li>
          <li>• ขอดูพรีวิวเฟรมและนำวิดีโอ/รูปของคุณเองมาใช้เป็น B-roll หรือคลิปพิธีกรได้ (PRO / BUSINESS)</li>
        </ul>
      </div>

      {/* Accurate setup note */}
      {setupNote && (
        <div className="flex items-start gap-2.5 rounded-xl p-3"
          style={setupNote.ok
            ? { background: "hsl(142 72% 29% / 0.08)", border: "1px solid hsl(142 72% 29% / 0.25)" }
            : { background: "hsl(38 92% 50% / 0.06)", border: "1px solid hsl(38 92% 50% / 0.22)" }}>
          <KeyRound className={`h-4 w-4 shrink-0 mt-0.5 ${setupNote.ok ? "text-emerald-300" : "text-amber-300"}`} strokeWidth={2.25} />
          <p className="text-xs leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
            {setupNote.text}
            {!setupNote.ok && (
              <>
                {" "}
                <a href="/settings?tab=api-keys" className="text-amber-300 hover:underline">ไปตั้งค่า →</a>
              </>
            )}
          </p>
        </div>
      )}

      {/* Step 1 — เลือก AI ของคุณ */}
      <div className="rounded-2xl border border-white/10 bg-white/3 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Terminal className="h-4 w-4 text-violet-400" strokeWidth={2.25} />
          <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ขั้นตอนที่ 1 — เลือก AI ของคุณ (1-Click Copy)</p>
        </div>
        <ConnectGuide token={TOKEN_PLACEHOLDER} />
      </div>

      {/* Step 2 — Tokens */}
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-violet-400" strokeWidth={2.25} />
            <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ขั้นตอนที่ 2 — Token (เฉพาะทาง &quot;เชื่อมด้วย Token&quot;)</p>
          </div>
          <button onClick={() => { setNewToken(null); setName(""); setOpen(true); }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))" }}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> สร้าง Token
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-white/40" /></div>
        ) : tokens.length === 0 ? (
          <div className="mt-2 rounded-2xl border border-white/10 bg-white/3 p-8 text-center text-sm" style={{ color: "var(--ui-text-muted)" }}>
            ยังไม่มี token — กด “สร้าง Token” ถ้าเชื่อมแบบ Token (Claude cowork/Desktop/Web ไม่ต้องใช้ token)
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/3 p-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: "var(--ui-text-primary)" }}>{t.name || "Token"}</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>
                    สร้าง {new Date(t.createdAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}
                    {t.lastUsedAt ? ` · ใช้ล่าสุด ${new Date(t.lastUsedAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}` : " · ยังไม่เคยใช้"}
                    {t.expiresAt ? ` · หมดอายุ ${new Date(t.expiresAt).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                  </p>
                </div>
                <button onClick={() => revoke(t.id)} disabled={revoking === t.id}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                  style={{ border: "1px solid hsl(0 0% 100% / 0.08)", color: "var(--ui-text-muted)" }}>
                  {revoking === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />}
                  เพิกถอน
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Step 3 — Creator Prompt Pack (5 พร้อมรันทันที) */}
      <div className="rounded-2xl border border-white/10 bg-white/3 p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <PlayCircle className="h-4 w-4 text-violet-400" strokeWidth={2.25} />
            <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>
              ขั้นตอนที่ 3 — Creator Prompt Pack (คัดลอกไปวางในแชท AI ได้ทันที)
            </p>
          </div>
          <span className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>
            5 แม่แบบยอดนิยม
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {MCP_CREATOR_PROMPT_TEMPLATES.map((tpl) => (
            <div key={tpl.id} className="flex flex-col justify-between rounded-xl border border-white/10 bg-black/30 p-3.5 space-y-2.5">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold" style={{ color: "var(--ui-text-primary)" }}>{tpl.title}</span>
                  <span className="rounded-md bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300">
                    {tpl.category} · {tpl.templateId}
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: "var(--ui-text-muted)" }}>{tpl.subtitle}</p>
                <p className="rounded-lg bg-black/40 p-2.5 text-[11px] leading-relaxed line-clamp-3" style={{ color: "var(--ui-text-secondary)" }}>
                  {tpl.prompt}
                </p>
              </div>
              <button
                onClick={() =>
                  copyText(tpl.prompt, ` Prompt "${tpl.title}" `, {
                    event: "mcp_prompt_pack_copied",
                    properties: {
                      promptId: tpl.id,
                      templateId: tpl.templateId,
                      category: tpl.category,
                      allowed,
                    },
                  })
                }
                className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold text-violet-200 transition-colors hover:bg-white/10"
                style={{ border: "1px solid hsl(0 0% 100% / 0.1)" }}
              >
                <Copy className="h-3.5 w-3.5" /> คัดลอก Prompt นี้
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Reconnect note */}
      <p className="flex items-start gap-2 text-[11px] leading-relaxed" style={{ color: "var(--ui-text-muted)" }}>
        <RefreshCw className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        เชื่อมไว้ก่อนแล้วแต่ไม่เห็นเครื่องมือใหม่? ตัดการเชื่อมต่อแล้วเชื่อมใหม่ในแอป AI
      </p>

      {/* Generate / show-once dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{newToken ? "Token ของคุณ" : "สร้าง Access Token"}</DialogTitle>
            <DialogDescription>
              {newToken ? "คัดลอกเก็บไว้เดี๋ยวนี้ — token นี้จะไม่ถูกแสดงอีก" : "ตั้งชื่อเครื่อง/agent เพื่อจำว่า token นี้ใช้ที่ไหน"}
            </DialogDescription>
          </DialogHeader>

          {newToken ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="rounded-lg bg-black/40 p-3 text-xs break-all text-violet-300">{newToken}</div>
                <button onClick={() => copyText(newToken, "token")} className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white" style={{ background: "hsl(var(--accent-primary) / 0.15)", border: "1px solid hsl(var(--accent-primary) / 0.3)" }}>
                  <Copy className="h-4 w-4" /> คัดลอก token
                </button>
              </div>
              <ConnectGuide token={newToken} />
            </div>
          ) : (
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น MacBook Claude Code" className="h-10 rounded-lg border-0 text-sm" style={{ background: "var(--ui-input-bg)", padding: "0 12px", color: "var(--ui-text-secondary)" }} />
          )}

          <DialogFooter>
            {newToken ? (
              <button onClick={() => setOpen(false)} className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white" style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))" }}>
                <Check className="h-4 w-4" /> เสร็จแล้ว
              </button>
            ) : (
              <button onClick={createToken} disabled={creating} className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-50" style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))" }}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} สร้าง
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
