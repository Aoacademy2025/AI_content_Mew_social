import fs from "node:fs";
import path from "node:path";

export function storyFilmCharacterReferencesDir() {
  const configured = process.env.STORY_FILM_CHARACTER_STORAGE_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) throw new Error("STORY_FILM_CHARACTER_STORAGE_DIR must be absolute");
  const directory = path.resolve(configured || path.join(process.cwd(), "uploads", "story-film-character-references"));
  const publicDirectory = path.resolve(process.cwd(), "public");
  if (directory === publicDirectory || directory.startsWith(`${publicDirectory}${path.sep}`)) {
    throw new Error("Story Film character storage must stay outside public/");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  return directory;
}
