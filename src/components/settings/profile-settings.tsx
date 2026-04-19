"use client";

import { useState, useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ProfileSettingsProps {
  user?: { name?: string | null; email?: string | null; role?: string; plan?: string };
}

const INP = "h-10 rounded-lg border-0 text-sm focus-visible:ring-1 focus-visible:ring-cyan-500/50";

export function ProfileSettings({ user }: ProfileSettingsProps) {
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [initials, setInitials] = useState("U");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user?.name) {
      setName(user.name);
      setInitials(user.name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2));
    }
    fetch("/api/user/avatar").then(r => r.json()).then(d => setAvatar(d.avatar ?? null)).catch(() => {});
  }, [user?.name]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error("File too large (max 2MB)"); return; }
    const reader = new FileReader();
    reader.onload = () => setPendingAvatar(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleSaveAvatar() {
    if (!pendingAvatar) return;
    setSavingAvatar(true);
    try {
      const res = await fetch("/api/user/avatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatar: pendingAvatar }) });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      setAvatar(pendingAvatar); setPendingAvatar(null);
      toast.success("Profile picture updated");
    } catch (err: any) { toast.error(err.message || "Error"); }
    finally { setSavingAvatar(false); }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true);
    try {
      const res = await fetch("/api/user/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      if (!res.ok) throw new Error();
      toast.success("Profile updated");
    } catch { toast.error("Failed to update profile"); }
    finally { setLoading(false); }
  }

  const displayAvatar = pendingAvatar ?? avatar;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Avatar */}
      <div className="flex items-center gap-5">
        <div className="relative shrink-0">
          <Avatar className="h-16 w-16 ring-2 ring-white/10">
            {displayAvatar && <AvatarImage src={displayAvatar} alt={user?.name || ""} className="object-cover" />}
            <AvatarFallback className="text-base font-semibold text-white" style={{ background: "linear-gradient(135deg, hsl(190 100% 50%), hsl(220 100% 60%))" }}>
              {initials}
            </AvatarFallback>
          </Avatar>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full text-white shadow-md transition-opacity hover:opacity-90"
            style={{ background: "hsl(190 100% 50%)" }}
          >
            <Camera className="h-3 w-3" />
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
        </div>
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--ui-text-secondary)" }}>Profile Picture</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--ui-text-muted)" }}>JPG, PNG or GIF · max 2MB</p>
          {pendingAvatar && (
            <button type="button" onClick={handleSaveAvatar} disabled={savingAvatar}
              className="mt-2 flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-cyan-400 transition-colors hover:text-cyan-300"
              style={{ background: "hsl(190 100% 50% / 0.1)", border: "1px solid hsl(190 100% 50% / 0.25)" }}>
              {savingAvatar && <Loader2 className="h-3 w-3 animate-spin" />}
              Save Photo
            </button>
          )}
        </div>
      </div>

      {/* Fields */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--ui-text-muted)" }}>Display Name</label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className={INP}
            style={{ background: "var(--ui-input-bg)", padding: "0 12px", color: "var(--ui-text-secondary)" }} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--ui-text-muted)" }}>Email Address</label>
          <Input value={user?.email || ""} disabled className={INP + " opacity-50"}
            style={{ background: "var(--ui-input-bg)", padding: "0 12px", color: "var(--ui-text-secondary)" }} />
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <button type="button" className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
          Reset Password
        </button>
        <button type="submit" disabled={loading}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: "linear-gradient(135deg, hsl(190 100% 45%), hsl(220 100% 58%))" }}>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save Changes
        </button>
      </div>
    </form>
  );
}
