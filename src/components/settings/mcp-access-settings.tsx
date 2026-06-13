"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Copy, Trash2, Terminal, Check, ArrowRight } from "lucide-react";
import { toast } from "sonner";

type TokenRow = { id: string; name: string | null; lastUsedAt: string | null; createdAt: string; expiresAt: string | null };

const MCP_URL = "https://studio.heroaiengine.com/api/mcp";
const connectCommand = (token: string) =>
  `claude mcp add --transport http heroai ${MCP_URL} \\\n  --header "Authorization: Bearer ${token}"`;

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

  function copy(textValue: string, label: string) {
    navigator.clipboard.writeText(textValue).then(() => toast.success(`คัดลอก${label}แล้ว`)).catch(() => toast.error("คัดลอกไม่สำเร็จ"));
  }

  if (!allowed) {
    return (
      <a href="/pricing" className="group block rounded-xl p-5 transition-all hover:-translate-y-0.5"
        style={{ background: "linear-gradient(135deg, hsl(var(--accent-primary) / 0.12), hsl(var(--accent-secondary) / 0.08))", border: "1px solid hsl(var(--accent-primary) / 0.25)" }}>
        <p className="text-base font-bold" style={{ color: "var(--ui-text-primary)" }}>Agent / MCP เป็นฟีเจอร์ของแผน PRO/BUSINESS</p>
        <p className="text-sm mt-1 flex items-center gap-1" style={{ color: "var(--ui-text-muted)" }}>
          อัปเกรดเพื่อต่อ Claude Code / agent ของคุณเข้ากับ HERO AI <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </p>
      </a>
    );
  }

  return (
    <div className="space-y-5">
      {/* How to connect */}
      <div className="rounded-2xl border border-white/10 bg-white/3 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Terminal className="h-4 w-4 text-cyan-400" strokeWidth={2.25} />
          <p className="text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>ต่อ agent ของคุณเข้ากับ HERO AI</p>
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--ui-text-muted)" }}>
          สร้าง token แล้ววางในคำสั่งนี้ (Claude Code / CLI) — Endpoint: <code className="text-cyan-300">{MCP_URL}</code>
        </p>
        <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-zinc-300">{`claude mcp add --transport http heroai ${MCP_URL} \\
  --header "Authorization: Bearer <YOUR_TOKEN>"`}</pre>
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
          ยังไม่มี token — กด “สร้าง Token” เพื่อเริ่ม
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{newToken ? "Token ของคุณ" : "สร้าง Access Token"}</DialogTitle>
            <DialogDescription>
              {newToken ? "คัดลอกเก็บไว้เดี๋ยวนี้ — token นี้จะไม่ถูกแสดงอีก" : "ตั้งชื่อเครื่อง/agent เพื่อจำว่า token นี้ใช้ที่ไหน"}
            </DialogDescription>
          </DialogHeader>

          {newToken ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-black/40 p-3 text-xs break-all text-cyan-300">{newToken}</div>
              <button onClick={() => copy(newToken, "token")} className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white" style={{ background: "hsl(var(--accent-primary) / 0.15)", border: "1px solid hsl(var(--accent-primary) / 0.3)" }}>
                <Copy className="h-4 w-4" /> คัดลอก token
              </button>
              <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-zinc-300">{connectCommand(newToken)}</pre>
              <button onClick={() => copy(connectCommand(newToken), "คำสั่ง connect")} className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white/80" style={{ border: "1px solid hsl(0 0% 100% / 0.1)" }}>
                <Copy className="h-4 w-4" /> คัดลอกคำสั่ง connect
              </button>
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
