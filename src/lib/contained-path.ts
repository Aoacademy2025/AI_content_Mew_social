// Confine a user-named path to one directory. A lexical check (path.resolve + startsWith)
// stops "../" but not a symlink inside the directory that points outside it, so the
// candidate is resolved with realpath and must still sit under the directory's own
// realpath, and must be a regular file.
import fs from "fs";
import path from "path";

export type ContainedFile = { ok: true; path: string } | { ok: false; reason: "outside" | "missing" };

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** `relative` is joined under `root` (a leading "/" is treated as relative to it). */
export function resolveContainedFile(root: string, relative: string): ContainedFile {
  if (relative.includes("\0")) return { ok: false, reason: "outside" };
  const lexicalRoot = path.resolve(root);
  const lexical = path.resolve(lexicalRoot, `.${path.sep}${relative}`);
  if (lexical !== lexicalRoot && !within(lexicalRoot, lexical)) return { ok: false, reason: "outside" };
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync.native(lexicalRoot);
    real = fs.realpathSync.native(lexical);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!within(realRoot, real)) return real === realRoot ? { ok: false, reason: "missing" } : { ok: false, reason: "outside" };
  try {
    if (!fs.statSync(real).isFile()) return { ok: false, reason: "missing" };
  } catch {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, path: real };
}

/**
 * A same-origin media URL the app serves from disk → the contained file behind it.
 *   /api/stocks/<f>          → <cwd>/stocks/<f>          (only with `stocks: true`)
 *   /api/renders/<f>         → <cwd>/public/renders/<f>
 *   /<anything else>         → <cwd>/public/<anything else>
 * Anything that is not a "/" path (a relative path, a URL) is "outside".
 */
export function resolveLocalMediaFile(url: string, opts: { stocks?: boolean } = {}): ContainedFile {
  if (!url.startsWith("/") || url.startsWith("//")) return { ok: false, reason: "outside" };
  const cwd = process.cwd();
  if (url.startsWith("/api/stocks/")) {
    if (!opts.stocks) return { ok: false, reason: "outside" };
    return resolveContainedFile(path.join(cwd, "stocks"), url.slice("/api/stocks/".length));
  }
  const publicPath = url.startsWith("/api/renders/") ? `/renders/${url.slice("/api/renders/".length)}` : url;
  return resolveContainedFile(path.join(cwd, "public"), publicPath);
}
