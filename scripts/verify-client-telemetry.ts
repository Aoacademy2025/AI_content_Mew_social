import assert from "node:assert/strict";
import { getTelemetrySessionId, trackEvent } from "../src/lib/client-telemetry";

// HERO-86: storage access can throw at the getter, before getItem/setItem run.
const saved = new Map(["window", "navigator", "fetch"].map((key) => [
  key, Object.getOwnPropertyDescriptor(globalThis, key),
]));
const sessionKey = "heroTelemetrySessionId";
const denied = () => { throw new DOMException("Access is denied for this document.", "SecurityError"); };
const payloads: Blob[] = [];
let checks = 0;

function browser(storage: () => unknown, path = "/") {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { get localStorage() { return storage(); }, location: { pathname: path } },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { sendBeacon(url: string, payload: Blob) {
      assert.equal(url, "/api/telemetry");
      payloads.push(payload);
      return true;
    } },
  });
}

async function main() {
  try {
    for (const [name, storage] of [
      ["getter denied", denied],
      ["storage absent", () => null],
      ["getItem denied", () => ({ getItem: denied })],
      ["setItem denied", () => ({ getItem: () => null, setItem: denied })],
    ] as const) {
      for (const path of ["/", "/dashboard"]) {
        browser(storage, path);
        assert.equal(getTelemetrySessionId(), null, `${name}: no session is available`);
        assert.doesNotThrow(() => trackEvent("page_viewed"), `${name}: page-view telemetry must not throw`);
        const payload = JSON.parse(await payloads.pop()!.text());
        assert.equal(payload.sessionId, null);
        assert.equal(payload.name, "page_viewed");
        assert.equal(payload.path, path);
        checks++;
      }
    }

    const values = new Map<string, string>();
    let writes = 0;
    browser(() => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { writes++; values.set(key, value); },
    }));
    const first = getTelemetrySessionId();
    assert.ok(first);
    assert.equal(values.get(sessionKey), first);
    assert.equal(getTelemetrySessionId(), first, "an existing session is reused");
    assert.equal(writes, 1, "the session is only created once");
    trackEvent("page_viewed");
    assert.equal(JSON.parse(await payloads.pop()!.text()).sessionId, first);
    checks++;

    // A browser whose delivery fails must still tolerate denied storage.
    browser(denied);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { sendBeacon: () => false } });
    let fetches = 0;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => {
      fetches++;
      return Promise.reject(new TypeError("Failed to fetch"));
    } });
    assert.doesNotThrow(() => trackEvent("page_viewed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1);
    checks++;

    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "navigator");
    assert.equal(getTelemetrySessionId(), null, "server-side execution has no browser session");
    assert.doesNotThrow(() => trackEvent("page_viewed"));
    assert.equal(fetches, 1, "server-side telemetry does not send a request");
    checks++;
    console.log(`client-telemetry: ${checks} scenarios passed`);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
