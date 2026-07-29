"use client";

import { useState, useEffect, useCallback } from "react";
import { Coins, Loader2, Zap, Star, Rocket } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface CreditBalance {
  granted: number;
  purchased: number;
  total: number;
  live: boolean;
}

const PACKS = [
  {
    id: "starter",
    label: "Starter",
    icon: Zap,
    baht: 199,
    credits: 200,
    bonus: null as string | null,
    accentFrom: "hsl(var(--accent-primary))",
    accentTo: "hsl(var(--accent-secondary))",
    glowColor: "hsl(var(--accent-primary) / 0.25)",
    borderColor: "hsl(var(--accent-primary) / 0.25)",
  },
  {
    id: "popular",
    label: "Popular",
    icon: Star,
    baht: 499,
    credits: 540,
    bonus: "+8%",
    accentFrom: "hsl(38 92% 55%)",
    accentTo: "hsl(38 92% 45%)",
    glowColor: "hsl(38 92% 50% / 0.25)",
    borderColor: "hsl(38 92% 50% / 0.35)",
    highlight: true,
  },
  {
    id: "pro",
    label: "Pro",
    icon: Rocket,
    baht: 999,
    credits: 1150,
    bonus: "+15%",
    accentFrom: "hsl(252 70% 65%)",
    accentTo: "hsl(280 80% 60%)",
    glowColor: "hsl(252 70% 60% / 0.25)",
    borderColor: "hsl(252 70% 60% / 0.35)",
  },
] as const;

export function CreditsBillingSection() {
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true);
    try {
      const res = await fetch("/api/credits/balance");
      if (res.ok) {
        const data: CreditBalance = await res.json();
        setBalance(data);
      }
    } catch {
      // fail-soft — hide section gracefully
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // Handle ?credits= URL param — show toast + refetch
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const credits = params.get("credits");
    if (credits === "success") {
      toast.success("ซื้อเครดิตสำเร็จ! เครดิตเพิ่มเข้าบัญชีแล้ว 🎉");
      fetchBalance();
      // Clean up the URL param without affecting other params
      const newParams = new URLSearchParams(window.location.search);
      newParams.delete("credits");
      const newSearch = newParams.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (newSearch ? `?${newSearch}` : "")
      );
    } else if (credits === "cancelled") {
      toast.info("ยกเลิกการซื้อเครดิตแล้ว");
      const newParams = new URLSearchParams(window.location.search);
      newParams.delete("credits");
      const newSearch = newParams.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (newSearch ? `?${newSearch}` : "")
      );
    }
  }, [fetchBalance]);

  async function buyPack(packId: string) {
    setBuying(packId);
    try {
      const res = await fetch("/api/payments/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: packId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "ไม่สามารถดำเนินการได้ กรุณาลองใหม่");
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      toast.error("เกิดข้อผิดพลาด กรุณาลองใหม่");
    } finally {
      setBuying(null);
    }
  }

  // Don't render at all while loading to avoid flash
  if (balanceLoading) return null;

  // If the server returned live:false, don't render (flag is off server-side too)
  if (!balance || !balance.live) return null;

  return (
    <div id="credits" className="scroll-mt-6 space-y-4 pt-6 border-t border-white/5">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Coins
          className="h-4 w-4"
          style={{ color: "hsl(var(--accent-primary))" }}
          strokeWidth={2.25}
        />
        <p className="eyebrow">เครดิต AI</p>
      </div>

      {/* Balance card */}
      <div
        className="rounded-xl p-4"
        style={{
          background:
            "linear-gradient(135deg, hsl(var(--accent-primary) / 0.08), hsl(var(--accent-secondary) / 0.04))",
          border: "1px solid hsl(var(--accent-primary) / 0.18)",
        }}
      >
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium tracking-wide uppercase" style={{ color: "var(--ui-text-muted)" }}>
              เครดิตแถมเดือนนี้
            </span>
            <span className="text-2xl font-black tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
              {balance.granted.toLocaleString()}
            </span>
          </div>
          <div
            className="w-px self-stretch"
            style={{ background: "hsl(0 0% 100% / 0.06)" }}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium tracking-wide uppercase" style={{ color: "var(--ui-text-muted)" }}>
              เครดิตที่ซื้อ
            </span>
            <span className="text-2xl font-black tracking-tight" style={{ color: "var(--ui-text-primary)" }}>
              {balance.purchased.toLocaleString()}
            </span>
          </div>
          <div
            className="w-px self-stretch"
            style={{ background: "hsl(0 0% 100% / 0.06)" }}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium tracking-wide uppercase" style={{ color: "var(--ui-text-muted)" }}>
              รวม
            </span>
            <span
              className="text-2xl font-black tracking-tight"
              style={{ color: "hsl(var(--accent-primary))" }}
            >
              {balance.total.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Pack cards */}
      <p className="text-xs mt-2" style={{ color: "var(--ui-text-muted)" }}>
        เติมเครดิตเพื่อเติมนาทีเมื่อใช้เกินโควต้าแพ็ก (2 เครดิต = 1 นาที) · <span style={{ color: "hsl(var(--accent-primary) / 0.8)" }}>เครดิตที่ซื้ออยู่ถาวร ไม่หายแม้เปลี่ยนแผน</span>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {PACKS.map((pack) => {
          const PackIcon = pack.icon;
          const isLoading = buying === pack.id;
          const isHighlight = "highlight" in pack && pack.highlight;

          return (
            <div
              key={pack.id}
              className={cn(
                "relative overflow-hidden rounded-xl p-4 flex flex-col gap-3 transition-all",
                isHighlight && "ring-1"
              )}
              style={{
                background: isHighlight
                  ? "linear-gradient(135deg, hsl(38 92% 50% / 0.12), hsl(38 92% 40% / 0.06))"
                  : "hsl(0 0% 100% / 0.03)",
                border: isHighlight
                  ? `1px solid ${pack.borderColor}`
                  : "1px solid hsl(0 0% 100% / 0.08)",
                boxShadow: isHighlight
                  ? `0 8px 24px ${pack.glowColor}`
                  : undefined,
                ...(isHighlight ? { ringColor: pack.borderColor } : {}),
              }}
            >
              {/* Ambient glow for highlight */}
              {isHighlight && (
                <div
                  className="absolute -top-6 -right-6 h-24 w-24 rounded-full blur-2xl pointer-events-none opacity-40"
                  style={{ background: pack.glowColor }}
                />
              )}

              {/* Bonus badge */}
              {pack.bonus && (
                <div className="absolute top-3 right-3">
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                    style={{
                      background: `${pack.accentFrom}22`,
                      border: `1px solid ${pack.accentFrom}55`,
                      color: pack.accentFrom,
                    }}
                  >
                    {pack.bonus}
                  </span>
                </div>
              )}

              {/* Icon + label */}
              <div className="flex items-center gap-2">
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                  style={{
                    background: `linear-gradient(135deg, ${pack.accentFrom}, ${pack.accentTo})`,
                    boxShadow: `0 4px 12px ${pack.glowColor}`,
                  }}
                >
                  <PackIcon className="h-4 w-4 text-white" strokeWidth={2.5} />
                </div>
                <span
                  className="text-sm font-bold tracking-tight"
                  style={{ color: "var(--ui-text-primary)" }}
                >
                  {pack.label}
                </span>
              </div>

              {/* Credits */}
              <div>
                <span
                  className="text-3xl font-black tracking-tight"
                  style={{ color: "var(--ui-text-primary)" }}
                >
                  {pack.credits.toLocaleString()}
                </span>
                <span
                  className="text-xs ml-1"
                  style={{ color: "var(--ui-text-muted)" }}
                >
                  เครดิต
                </span>
              </div>

              {/* Buy button */}
              <button
                onClick={() => buyPack(pack.id)}
                disabled={isLoading || buying !== null}
                className="flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-bold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: `linear-gradient(135deg, ${pack.accentFrom}, ${pack.accentTo})`,
                  color: isHighlight ? "#1a1100" : "#fff",
                  boxShadow: `0 4px 12px ${pack.glowColor}, inset 0 1px 0 rgba(255,255,255,0.15)`,
                }}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                ฿{pack.baht.toLocaleString()}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
