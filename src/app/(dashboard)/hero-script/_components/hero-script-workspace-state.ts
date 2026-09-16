export type HeroScriptWorkspaceTab = "write" | "library";

export interface HeroScriptWorkspaceState {
  activeTab: HeroScriptWorkspaceTab;
  topic: string;
  selectedHook: unknown;
  draft: unknown;
}

export interface HeroScriptWritingPreferences {
  profileId: string | null;
  durationSec: 30 | 60 | 90;
}

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter extends StorageReader {
  setItem(key: string, value: string): void;
}

const DEFAULT_PREFERENCES: HeroScriptWritingPreferences = { profileId: null, durationSec: 60 };

export function switchHeroScriptWorkspaceTab<T extends HeroScriptWorkspaceState>(
  workspace: T,
  activeTab: HeroScriptWorkspaceTab,
): T {
  return { ...workspace, activeTab };
}

function preferencesKey(accountId: string): string {
  return `hero-script-writing:${accountId}`;
}

export function readHeroScriptWritingPreferences(
  storage: StorageReader,
  accountId: string,
  profiles: ReadonlyArray<{ id: string }>,
): HeroScriptWritingPreferences {
  try {
    const raw = storage.getItem(preferencesKey(accountId));
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as { profileId?: unknown; durationSec?: unknown };
    const durationSec = parsed.durationSec === 30 || parsed.durationSec === 60 || parsed.durationSec === 90
      ? parsed.durationSec
      : DEFAULT_PREFERENCES.durationSec;
    const profileId = typeof parsed.profileId === "string" && profiles.some((profile) => profile.id === parsed.profileId)
      ? parsed.profileId
      : null;
    return { profileId, durationSec };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function writeHeroScriptWritingPreferences(
  storage: StorageWriter,
  accountId: string,
  preferences: HeroScriptWritingPreferences,
) {
  try {
    storage.setItem(preferencesKey(accountId), JSON.stringify(preferences));
  } catch {
    // Browser storage can be unavailable in private browsing; the live workspace still works.
  }
}
