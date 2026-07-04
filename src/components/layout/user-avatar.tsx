"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface UserAvatarProps {
  /** Display name — used for initials fallback + accessible label. */
  name?: string | null;
  /** Uploaded profile photo (base64 data-URL from User.avatar via /api/user/me). */
  avatar?: string | null;
  /** Diameter in px (default 36). */
  size?: number;
  className?: string;
}

/**
 * Shared user avatar. Renders the real uploaded photo when `avatar` is present,
 * otherwise a violet gradient circle with the name's initials. Presentational only —
 * callers pass name+avatar from fetchMe() (DB values), so the sidebar, editor topbar
 * account menu, and support modal all show ONE consistent identity.
 */
export function UserAvatar({ name, avatar, size = 36, className }: UserAvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);

  const initials =
    (name ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "U";

  if (avatar && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatar}
        alt={name ? `${name} profile photo` : "Profile photo"}
        width={size}
        height={size}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={name ? `${name} profile` : "Profile"}
      className={cn("flex shrink-0 items-center justify-center rounded-full font-bold text-white", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.34)),
        background: "linear-gradient(135deg, hsl(252 83% 45%), hsl(258 90% 55%))",
      }}
    >
      {initials}
    </div>
  );
}
