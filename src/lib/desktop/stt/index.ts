import { createGeminiTranscribeProvider } from "./gemini-transcribe";
import { createHeroChunkedProvider } from "./hero-chunked";
import type { DesktopSttProvider } from "./types";

export type { DesktopSttOptions, DesktopSttProvider, DesktopSttResult, DesktopSttSegment, DesktopSttWord } from "./types";

type GeminiUser = { geminiKey: string | null; plan: string };

let providerOverride: DesktopSttProvider | null = null;

export function selectedDesktopSttProviderName(): "gemini-transcribe" | "hero-chunked" {
  return process.env.DESKTOP_STT_PROVIDER === "hero-chunked" ? "hero-chunked" : "gemini-transcribe";
}

export function resolveDesktopSttProvider(user: GeminiUser): DesktopSttProvider {
  if (providerOverride) return providerOverride;
  return selectedDesktopSttProviderName() === "hero-chunked"
    ? createHeroChunkedProvider(user)
    : createGeminiTranscribeProvider(user);
}

/** Test-only. Requires DESKTOP_TRANSCRIBE_VERIFY=1. Never used by production routes. */
export function setDesktopSttProviderForTests(provider: DesktopSttProvider | null): void {
  if (process.env.DESKTOP_TRANSCRIBE_VERIFY !== "1") {
    throw new Error("Desktop STT provider override requires DESKTOP_TRANSCRIBE_VERIFY=1");
  }
  providerOverride = provider;
}
