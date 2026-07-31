"use client";

// TopicStep — Hero Script UI spec step 2 ("หัวข้อ"): topic input + ปุ่ม
// "คิดไอเดียให้หน่อย" → 8 idea cards (topic + angle); clicking one fills the
// topic. Calls POST /api/scripts/ideas with the selected BrandProfile (or
// none — the route treats brandProfileId as optional, see the route's
// header comment).

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const VIOLET = "#8B5CF6";

// 429 quota copy — exact Thai string from the shared spec's "Quota/error states" table.
const QUOTA_MESSAGE = "ใช้โควตา AI ครบรอบนี้แล้ว รอรีเซ็ตหรืออัปเกรดแผน";

export interface ScriptIdea {
  topic: string;
  angle: string;
}

async function toastErrorResponse(res: Response, fallback: string) {
  let data: { error?: string; code?: string } | null = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 429) { toast.error(QUOTA_MESSAGE); return; }
  if (res.status === 409 && data?.code === "KEY_REQUIRED") {
    toast.error("ยังไม่ได้ตั้งค่า Gemini API key — ไปที่ Settings เพื่อเพิ่มคีย์");
    return;
  }
  toast.error(data?.error || fallback);
}

interface TopicStepProps {
  selectedProfileId: string | null;
  topic: string;
  onTopicChange: (topic: string) => void;
}

export function TopicStep({ selectedProfileId, topic, onTopicChange }: TopicStepProps) {
  const [loading, setLoading] = useState(false);
  const [ideas, setIdeas] = useState<ScriptIdea[]>([]);

  async function handleGenerateIdeas() {
    setLoading(true);
    try {
      const res = await fetch("/api/scripts/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandProfileId: selectedProfileId }),
      });
      if (!res.ok) { await toastErrorResponse(res, "คิดไอเดียไม่สำเร็จ"); return; }
      const data = await res.json();
      setIdeas(Array.isArray(data.ideas) ? data.ideas : []);
    } catch {
      toast.error("คิดไอเดียไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--ui-card-bg)", border: "1px solid var(--ui-card-border)" }}>
      <h2 className="mb-4 text-sm font-semibold" style={{ color: "var(--ui-text-primary)" }}>หัวข้อ</h2>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Label className="mb-1.5 block text-xs" style={{ color: "var(--ui-text-secondary)" }}>หัวข้อคลิป</Label>
          <Input className="min-h-11" value={topic} onChange={(e) => onTopicChange(e.target.value)} />
        </div>
        <Button
          onClick={handleGenerateIdeas}
          disabled={loading}
          className="min-h-11 gap-1.5 text-white sm:shrink-0"
          style={{ background: VIOLET }}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          คิดไอเดียให้หน่อย
        </Button>
      </div>

      {ideas.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {ideas.map((idea, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onTopicChange(idea.topic)}
              className="rounded-lg border p-3 text-left text-xs transition-colors hover:border-violet-400"
              style={{
                borderColor: topic === idea.topic ? VIOLET : "var(--ui-card-border)",
                background: topic === idea.topic ? "rgba(139,92,246,.08)" : "transparent",
              }}
            >
              <p className="mb-1 font-medium" style={{ color: "var(--ui-text-primary)" }}>{idea.topic}</p>
              <p style={{ color: "var(--ui-text-muted)" }}>{idea.angle}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
