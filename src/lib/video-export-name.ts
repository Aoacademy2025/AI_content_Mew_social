const DEFAULT_PROJECT_TITLE = "New Project";
const SCRIPT_TITLE_LIMIT = 40;
const FILENAME_STEM_LIMIT = 80;
const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface VideoNameInput {
  projectTitle?: string | null;
  headline?: string | null;
  script?: string | null;
}

function trimmed(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  return candidate ? candidate : null;
}

function scriptTitle(script: string | null | undefined): string | null {
  const candidate = trimmed(script);
  if (!candidate) return null;
  const chars = Array.from(candidate);
  return chars.length > SCRIPT_TITLE_LIMIT
    ? `${chars.slice(0, SCRIPT_TITLE_LIMIT).join("")}...`
    : candidate;
}

export function resolveVideoDisplayName(input: VideoNameInput): string {
  const projectTitle = trimmed(input.projectTitle);
  if (projectTitle && projectTitle !== DEFAULT_PROJECT_TITLE) return projectTitle;
  return trimmed(input.headline) ?? scriptTitle(input.script) ?? "Untitled";
}

export function resolveVideoDownloadFilename(input: VideoNameInput): string {
  let stem = resolveVideoDisplayName(input)
    .replace(/[\u0000-\u001f\u007f<>:\"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  stem = Array.from(stem).slice(0, FILENAME_STEM_LIMIT).join("").replace(/[. ]+$/g, "");
  if (!stem || WINDOWS_RESERVED_STEM.test(stem)) stem = "Untitled";
  return `${stem}.mp4`;
}
