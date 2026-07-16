// Pure predicate for detecting "stale client bundle" errors — a browser tab left open
// across a deploy still holds pre-deploy Server Action IDs and JS/CSS chunk hashes that
// no longer exist once `deploy/deploy.sh` rebuilds `.next` in place and restarts the
// single ai-content PM2 process (self-hosted: no multi-version routing layer to fall
// back to old assets). See src/components/stale-bundle-guard.tsx for the consumer.
//
// Two failure families we recognize — and ONLY these, so ordinary network flakiness
// (a dropped fetch, a flaky third-party script) never trips the banner:
//
//   1. Server Action ID from the old bundle no longer exists on the rebuilt server.
//      Exact text Next.js throws (verified against the installed 15.3.9 source at
//      node_modules/next/dist/server/app-render/action-handler.js:464/588/789):
//        "Failed to find Server Action. This request might be from an older or newer
//         deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action"
//      (sometimes with the action id quoted in the middle — we match the stable prefix).
//
//   2. A JS/CSS chunk hash from the old bundle was wiped by the rebuild. Webpack's
//      client runtime (verified against node_modules/next/dist/compiled/webpack/bundle5.js)
//      throws an Error with `.name === "ChunkLoadError"` and a message shaped like
//      "Loading chunk <id> failed.\n(<type>: <url>)". Modern browsers throw a distinct
//      "Failed to fetch dynamically imported module: <url>" for the equivalent ESM case —
//      the browser embeds the failed module's URL in the message, so we require that URL
//      to be one of ours (`/_next/`) too; without that restriction this branch would also
//      fire on ordinary transient causes unrelated to stale deploys (offline mid-session,
//      an ad-blocker, any dynamic-import network blip against a third-party URL).

export interface StaleBundleSignal {
  message?: string | null;
  name?: string | null;
}

const SERVER_ACTION_NOT_FOUND = /Failed to find Server Action\b/i;
const CHUNK_LOAD_MESSAGE = /Loading (chunk|css chunk) .*failed/i;
const DYNAMIC_IMPORT_FAILED = /Failed to fetch dynamically imported module/i;
const NEXT_ASSET_PATH = /\/_next\//;

export function isStaleBundleSignal(signal: StaleBundleSignal): boolean {
  const message = signal.message ?? "";
  const name = signal.name ?? "";

  if (SERVER_ACTION_NOT_FOUND.test(message)) return true;
  if (name === "ChunkLoadError") return true;
  if (CHUNK_LOAD_MESSAGE.test(message)) return true;
  if (DYNAMIC_IMPORT_FAILED.test(message) && NEXT_ASSET_PATH.test(message)) return true;

  return false;
}

// Resource-load failures (an old <link rel="stylesheet"> or <script> 404ing) don't carry
// a message/name — they're plain `Event`s targeting the failed element, not ErrorEvents.
// Recognize them by URL shape instead: only Next's own static asset path counts, so an
// unrelated third-party script/image/font 404 (ad blocker, extension, flaky CDN) never
// trips the banner.
const NEXT_STATIC_ASSET = /\/_next\/static\//;

export function isStaleBundleResourceError(url: string | null | undefined): boolean {
  if (!url) return false;
  return NEXT_STATIC_ASSET.test(url);
}
