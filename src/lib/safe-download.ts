// Download a user-supplied URL to a local file so ffmpeg never sees the URL itself (ffmpeg
// follows redirects on its own, and nothing re-checks where they lead). Every hop goes
// through assertSafeFetchUrl with redirects handled here, and the body is capped while it
// streams, not after it is buffered.
import { once } from "events";
import fs from "fs";
import { assertSafeFetchUrl } from "@/lib/safe-fetch";

export type SafeDownloadFailure = "unsafe_url" | "bad_status" | "too_large" | "redirects" | "failed";

export class SafeDownloadError extends Error {
  constructor(public readonly reason: SafeDownloadFailure, message: string) {
    super(message);
    this.name = "SafeDownloadError";
  }
}

export interface SafeDownloadOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxHops?: number;
  /** Extra headers for a given hop (e.g. a provider key that must only go to its own host). */
  headers?: (currentUrl: string) => Record<string, string>;
  /** File mode for `dest`. Default 0600 (a private temp file); pass 0o666 (minus umask,
   *  like writeFileSync) for a file nginx will serve from disk. */
  mode?: number;
}

/** Downloads to `dest` (created exclusively). On any failure `dest` is removed. */
export async function safeDownloadToFile(url: string, dest: string, opts: SafeDownloadOptions): Promise<{ bytes: number; contentType: string | null }> {
  const maxHops = opts.maxHops ?? 3;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  let current = url;
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    try {
      await assertSafeFetchUrl(current);
    } catch {
      throw new SafeDownloadError("unsafe_url", "URL is not allowed");
    }
    try {
      res = await globalThis.fetch(current, { headers: opts.headers?.(current), redirect: "manual", signal });
    } catch {
      throw new SafeDownloadError("failed", "Download failed");
    }
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!location) throw new SafeDownloadError("bad_status", `Download failed (${res.status})`);
    if (hop >= maxHops) throw new SafeDownloadError("redirects", "Too many redirects");
    try {
      current = new URL(location, current).toString();
    } catch {
      throw new SafeDownloadError("unsafe_url", "URL is not allowed");
    }
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new SafeDownloadError("bad_status", `Download failed (${res.status})`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new SafeDownloadError("too_large", "File is too large");
  }

  const out = fs.createWriteStream(dest, { flags: "wx", mode: opts.mode ?? 0o600 });
  const opened = new Promise<void>((resolve, reject) => {
    out.once("open", () => resolve());
    out.once("error", reject);
  });
  const reader = res.body.getReader();
  let bytes = 0;
  let created = false;
  try {
    await opened;
    created = true;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > opts.maxBytes) throw new SafeDownloadError("too_large", "File is too large");
      // events.once removes both its listeners when either fires (a hand-rolled
      // once("drain") + once("error") pair left one "error" listener behind per wait).
      if (!out.write(value)) await once(out, "drain");
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
    return { bytes, contentType: res.headers.get("content-type") };
  } catch (error) {
    await reader.cancel().catch(() => {});
    out.destroy();
    // Never remove a file this call did not create (the exclusive open failed).
    if (created) try { fs.unlinkSync(dest); } catch {}
    if (error instanceof SafeDownloadError) throw error;
    throw new SafeDownloadError("failed", "Download failed");
  }
}

/** Move a finished temp file into place: rename, or copy + unlink when the temp dir is on
 *  another filesystem. The copy never overwrites an existing file. */
export function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}
