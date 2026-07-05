"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Copy, Trash2, Terminal, Check, ArrowRight, Sparkles, Code2, Bot, Zap, KeyRound } from "lucide-react";
import { toast } from "sonner";

type TokenRow = { id: string; name: string | null; lastUsedAt: string | null; createdAt: string; expiresAt: string | null };

const MCP_URL = "https://studio.heroaiengine.com/api/mcp";
const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";

function copyText(value: string, label: string) {
  navigator.clipboard.writeText(value).then(() => toast.success(`คัดลอก${label}แล้ว`)).catch(() => toast.error("คัดลอกไม่สำเร็จ"));
}

// ── Client connect definitions ───────────────────────────────────────────
// One source of truth: each client's snippet is a (token) => string so the
// same guide renders with a placeholder in the static box and the REAL token
// inside the show-once dialog.
type ClientId = "claude-cowork" | "claude-code" | "codex" | "openclaw" | "hermes";
type ClientGroup = "assistant" | "agent";

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
    group: "assistant",
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
    group: "assistant",
    icon: Terminal,
    blurb: "สั่งจาก terminal — คำสั่งเดียวจบ",
    needsToken: true,
    steps: ["รันคำสั่งนี้ใน terminal (วาง token ของคุณแทน)"],
    code: (t) => `claude mcp add --transport http heroai ${MCP_URL} \\\n  --header "Authorization: Bearer ${t}"`,
  },
  {
    id: "codex",
    label: "Codex (CLI)",
    group: "assistant",
    icon: Code2,
    blurb: "OpenAI Codex — token อ่านจาก environment variable",
    needsToken: true,
    steps: ["เพิ่ม server แล้วตั้ง env var ให้ token"],
    code: (t) => `codex mcp add heroai --url ${MCP_URL} \\\n  --bearer-token-env-var HEROAI_TOKEN\nexport HEROAI_TOKEN="${t}"`,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    group: "agent",
    icon: Bot,
    blurb: "Agent อัตโนมัติ — เพิ่มผ่าน CLI คำสั่งเดียว",
    needsToken: true,
    steps: ["รันคำสั่งนี้ (วาง token ของคุณแทน)"],
    code: (t) => `openclaw mcp add heroai --url ${MCP_URL} \\\n  --transport streamable-http --header "Authorization: Bearer ${t}"`,
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    group: "agent",
    icon: Zap,
    blurb: "Nous Research — เพิ่มในไฟล์ config",
    needsToken: true,
    steps: ["แก้ไฟล์ ~/.hermes/config.yaml เพิ่มบล็อกนี้ แล้วรีสตาร์ท Hermes"],
    code: (t) => `# ~/.hermes/config.yaml\nmcp_servers:\n  heroai:\n    url: "${MCP_URL}"\n    headers:\n      Authorization: "Bearer ${t}"`,
  },
];

const GROUP_LABEL: Record<ClientGroup, string> = {
  assistant: "ผู้ช่วย AI",
  agent: "Agent อัตโนมัติ",
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
          <button onClick={() => copyText(client.code!(token), "คำสั่ง")} title="คัดลอก"
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white">
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {client.needsToken && usingPlaceholder && (
        <p className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--ui-text-muted)" }}>
          <KeyRound className="h-3 w-3 text-amber-300" /> แทน <code className="text-amber-300">{TOKEN_PLACEHOLDER}</code> ด้วยคีย์จากปุ่ม “สร้าง Token” ด้านล่าง
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
  const groups: ClientGroup[] = ["assistant", "agent"];

  return (
    <div className="space-y-3">
      {/* Endpoint */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-black/30 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--ui-text-muted)" }}>Endpoint</span>
        <code className="flex-1 min-w-0 truncate text-xs text-violet-300">{MCP_URL}</code>
        <button onClick={() => copyText(MCP_URL, "Endpoint")} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/10 hover:text-white">
          <Copy className="h-3 w-3" /> คัดลอก
        </button>
      </div>

      {/* Picker — grouped pills */}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g} className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-[11px] font-semibold" style={{ color: "var(--ui-text-muted)" }}>{GROUP_LABEL[g]}</span>
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
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/mcp-tokens")
      .then((r) => r.json())
      .then((d) => setTokens(Array.isArray(d.tokens) ? d.tokens : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }
  useEffect(() => { if (allowed) load(); else setLoading(false); }, [allowed]);

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

  if (!allowed) {
    return (
      <a href="/pricing" className="group block rounded-xl p-5 transition-all hover:-translate-y-0.5"
        style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary) / 0.12), hsl(var(--accent-secondary) / 0.08))", border: "1px solid hsl(var(--accent-primary) / 0.25)" }}>
        <p className="text-base font-bold" style={{ color: "var(--ui-text-primary)" }}>Agent / MCP เป็นฟีเจอร์ของแผน PRO/BUSINESS</p>
        <p className="text-sm mt-1 flex items-center gap-1" style={{ color: "var(--ui-text-muted)" }}>
          อัปเกรดเพื่อต่อ Claude / Codex / OpenClaw / Hermes เข้ากับ HERO AI <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </p>
      </a>
    );
  }

  return (
    <div className="space-y-5">
      {/* Prerequisite note */}
      <a href="/settings?tab=api-keys" className="group flex items-start gap-2.5 rounded-xl p-3 transition-colors hover:bg-amber-500/5"
        style={{ background: "hsl(38 92% 50% / 0.06)", border: "1px solid hsl(38 92% 50% / 0.22)" }}>
        <KeyRound className="h-4 w-4 shrink-0 mt-0.5 text-amber-300" strokeWidth={2.25} />
        <p className="text-xs leading-relaxed" style={{ color: "var(--ui-text-secondary)" }}>
          <span className="font-semibold text-amber-200">ก่อนสั่งสร้างวิดีโอ:</span> ต้องตั้ง API Keys (Gemini + Pexels/Pixabay) ที่แท็บ API Keys ก่อน
          ไม่งั้น agent ต่อติดแต่สั่งงานจะ error <span className="text-amber-300 group-hover:underline">ไปตั้งค่า →</span>
        </p>
      </a>

      {/* How to connect — client picker */}
      <div className="rounded-2xl border border-white/10 bg-white/3 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Terminal className="h-4 w-4 text-violet-400" strokeWidth={2.25} />
          <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>เลือก agent ของคุณ แล้วทำตามขั้นตอน</p>
        </div>
        <ConnectGuide token={TOKEN_PLACEHOLDER} />
      </div>

      {/* Tokens */}
      <div className="flex items-center justify-between">
        <p className="eyebrow">Access Tokens</p>
        <button onClick={() => { setNewToken(null); setName(""); setOpen(true); }}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition-all hover:brightness-110"
          style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary)), hsl(var(--accent-secondary)))" }}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> สร้าง Token
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-white/40" /></div>
      ) : tokens.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/3 p-8 text-center text-sm" style={{ color: "var(--ui-text-muted)" }}>
          ยังไม่มี token — กด “สร้าง Token” เพื่อเริ่ม (Claude cowork ไม่ต้องใช้ token)
        </div>
      ) : (
        <div className="space-y-2">
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
              {/* ready-to-paste guide with the real token injected */}
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
