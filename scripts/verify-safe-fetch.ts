/**
 * verify-safe-fetch — the SSRF guard (`src/lib/safe-fetch.ts`) must refuse every address
 * form that reaches a non-public target, whether it arrives as a literal URL host or as a
 * DNS answer, and must keep accepting ordinary public hosts.
 *
 * The regression this pins: `http://[::ffff:127.0.0.1]` is normalised by the URL parser to
 * `[::ffff:7f00:1]`, which the old regex-based check treated as public (loopback SSRF).
 *
 * Embedded-IPv4 policy (decided here, see the module header):
 *   - IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` are judged by
 *     the IPv4 they carry, so `::ffff:8.8.8.8` is ALLOWED (the socket reaches 8.8.8.8, a
 *     public host) while `::ffff:127.0.0.1` is blocked.
 *   - IPv4-compatible `::a.b.c.d` (deprecated), the rest of `::/96`, Teredo `2001::/32` (the
 *     whole `2001::/23` IETF block) and anything outside global unicast `2000::/3` are
 *     blocked outright, whatever they embed.
 *
 * DNS is mocked through the `lookup` option, so this runs offline. One case uses the real
 * resolver on `localhost`, which `/etc/hosts` answers without a network.
 *
 * Run: npm run verify:safe-fetch
 */
import assert from "node:assert/strict";
import { assertSafeFetchUrl, isSafeFetchUrl, UnsafeUrlError } from "../src/lib/safe-fetch";

type Answer = Array<{ address: string; family?: number }>;

const failures: string[] = [];
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A lookup stub that answers every hostname with `answer` and counts its calls. */
function stubLookup(answer: Answer | Error) {
  const calls: string[] = [];
  const lookup = async (hostname: string) => {
    calls.push(hostname);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { lookup, calls };
}

/** A lookup that must never run — literal IP hosts are classified without DNS. */
const noDns = async (hostname: string): Promise<Answer> => {
  throw new Error(`DNS must not be consulted for a literal IP host (got ${hostname})`);
};

async function expectBlocked(url: string, lookup = noDns) {
  await assert.rejects(
    () => assertSafeFetchUrl(url, { lookup }),
    (err: unknown) => err instanceof UnsafeUrlError,
    `assertSafeFetchUrl must throw UnsafeUrlError for ${url}`,
  );
  assert.equal(await isSafeFetchUrl(url, { lookup }), false, `isSafeFetchUrl must be false for ${url}`);
}

async function expectAllowed(url: string, lookup = noDns) {
  await assertSafeFetchUrl(url, { lookup });
  assert.equal(await isSafeFetchUrl(url, { lookup }), true, `isSafeFetchUrl must be true for ${url}`);
}

// ── Address forms that must be refused ───────────────────────────────────────────────
// Each entry is written the way it can appear: a URL host (bracketed when IPv6) and/or a
// DNS answer. Dotted-tail IPv6 forms can only arrive through DNS, because the URL parser
// re-serialises every IPv6 literal into hex groups.

/** Private/special IPv4 targets, embedded below in every IPv6 wrapper. */
const PRIVATE_V4 = [
  "127.0.0.1", // loopback
  "10.0.0.1", // RFC 1918
  "172.16.0.1", // RFC 1918
  "192.168.1.1", // RFC 1918
  "169.254.169.254", // link-local / cloud metadata
  "100.64.0.1", // CGNAT
  "0.0.0.0", // "this network"
  "192.0.0.8", // IETF protocol assignments
  "198.18.0.1", // benchmarking
  "224.0.0.1", // multicast
  "255.255.255.255", // reserved / broadcast
];

const hex = (v4: string) => {
  const [a, b, c, d] = v4.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

/** Wrappers that carry an IPv4 inside an IPv6 address. */
const WRAPPERS: Array<{ name: string; dotted?: (v4: string) => string; hex: (v4: string) => string }> = [
  { name: "IPv4-mapped", dotted: (v) => `::ffff:${v}`, hex: (v) => `::ffff:${hex(v)}` },
  { name: "IPv4-mapped (full form)", hex: (v) => `0:0:0:0:0:ffff:${hex(v)}` },
  { name: "IPv4-compatible", dotted: (v) => `::${v}`, hex: (v) => `::${hex(v)}` },
  { name: "NAT64 64:ff9b::/96", dotted: (v) => `64:ff9b::${v}`, hex: (v) => `64:ff9b::${hex(v)}` },
  { name: "6to4 2002::/16", hex: (v) => `2002:${hex(v)}::1` },
  { name: "IPv4-translated ::ffff:0:0:0/96", dotted: (v) => `::ffff:0:${v}`, hex: (v) => `::ffff:0:${hex(v)}` },
];

/** Plain addresses that must be refused (IPv4 and IPv6). */
const BLOCKED_PLAIN = [
  ...PRIVATE_V4,
  "::", // unspecified
  "::1", // loopback
  "fe80::1", // link-local
  "febf:ffff::1", // link-local (top of fe80::/10)
  "fec0::1", // site-local (deprecated)
  "fc00::1", // unique-local
  "fd12:3456::1", // unique-local
  "ff02::1", // multicast
  "ff0e::1", // multicast
  "2001::1", // Teredo
  "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo (real-shaped, embeds obfuscated v4)
  "2001:0:4136:e378:8000:63bf:80f7:f7f7", // Teredo embedding a public v4 — still refused
  "2001:2::1", // IETF benchmarking (2001::/23)
  "2001:1ff:ffff::1", // top of 2001::/23
  "2001:db8::1", // documentation
  "1fff:ffff::1", // just below global unicast 2000::/3
  "e000::1", // above global unicast, below fc00::/7
  "100::1", // discard-only
  "64:ff9b:1::1", // NAT64 local-use
  "4000::1", // outside global unicast 2000::/3
  "::ffff:0:0", // mapped 0.0.0.0
];

// URL-only tricks that normalise to a private literal.
const BLOCKED_URL_TRICKS = [
  "http://0/", // → 0.0.0.0
  "http://127.1/", // → 127.0.0.1
  "http://2130706433/", // → 127.0.0.1
  "http://0x7f.1/", // → 127.0.0.1
  "http://0177.0.0.1/", // → 127.0.0.1 (octal)
  "http://user:pass@[::ffff:127.0.0.1]:8080/admin", // userinfo + port
  "https://[::ffff:169.254.169.254]/latest/meta-data/",
  "http://169.254.169.254/latest/meta-data/",
];

// Inputs that must fail closed (DNS answers that are not a clean IP literal).
const UNPARSEABLE_ANSWERS = ["", "not-an-ip", "1.2.3", "1.2.3.4.5", "256.0.0.1", "fe80::1%eth0", "::ffff:1.2.3", "8.8.8.8 "];

// ── Public controls that must keep working ───────────────────────────────────────────
const PUBLIC_ADDRESSES = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.215.14",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a00:1450:4001:80b::200e",
  "::ffff:8.8.8.8", // mapped public — judged by the IPv4 it carries
  "::ffff:808:808",
  "64:ff9b::8.8.8.8", // NAT64 to a public IPv4
  "64:ff9b::808:808",
  "2002:808:808::1", // 6to4 from a public IPv4
  "2001:200::1", // first public block after 2001::/23
  "2003::1", // next to 6to4, ordinary global unicast
  "3fff:ffff::1", // top of 2000::/3
];

const bracket = (ip: string) => (ip.includes(":") ? `[${ip}]` : ip);

async function main() {
  // 1. Literal URL hosts — every form, no DNS.
  for (const ip of BLOCKED_PLAIN) {
    await check(`literal blocked: ${ip}`, () => expectBlocked(`http://${bracket(ip)}/`));
  }
  for (const w of WRAPPERS) {
    for (const v4 of PRIVATE_V4) {
      for (const form of [w.dotted?.(v4), w.hex(v4)].filter(Boolean) as string[]) {
        await check(`literal blocked: ${w.name} ${form}`, () => expectBlocked(`http://[${form}]/`));
      }
    }
  }
  for (const url of BLOCKED_URL_TRICKS) {
    await check(`literal blocked: ${url}`, () => expectBlocked(url));
  }
  for (const ip of PUBLIC_ADDRESSES) {
    await check(`literal allowed: ${ip}`, () => expectAllowed(`https://${bracket(ip)}/img.jpg`));
  }

  // 2. The same forms as DNS answers for an innocent-looking hostname.
  const dnsBlocked: string[] = [...BLOCKED_PLAIN];
  for (const w of WRAPPERS) {
    for (const v4 of PRIVATE_V4) {
      if (w.dotted) dnsBlocked.push(w.dotted(v4));
      dnsBlocked.push(w.hex(v4));
      dnsBlocked.push(w.hex(v4).toUpperCase());
    }
  }
  for (const address of dnsBlocked) {
    await check(`dns blocked: rebind.example → ${address}`, async () => {
      const { lookup, calls } = stubLookup([{ address }]);
      await expectBlocked("https://rebind.example/a.png", lookup);
      assert.ok(calls.length > 0, "the hostname must be resolved");
    });
  }
  for (const address of UNPARSEABLE_ANSWERS) {
    await check(`dns fail-closed: unparseable answer ${JSON.stringify(address)}`, () =>
      expectBlocked("https://weird.example/", stubLookup([{ address }]).lookup),
    );
  }
  for (const address of PUBLIC_ADDRESSES) {
    await check(`dns allowed: cdn.example → ${address}`, () =>
      expectAllowed("https://cdn.example/a.png", stubLookup([{ address }]).lookup),
    );
  }

  // 3. Every resolved address is classified, not just the first.
  const mixed: Array<[string, Answer]> = [
    ["public A then mapped-loopback AAAA", [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }]],
    ["public AAAA then private A", [{ address: "2606:4700:4700::1111", family: 6 }, { address: "10.0.0.1", family: 4 }]],
    ["two public then NAT64 metadata", [{ address: "1.1.1.1" }, { address: "8.8.8.8" }, { address: "64:ff9b::a9fe:a9fe" }]],
    ["public then 6to4 loopback", [{ address: "8.8.4.4" }, { address: "2002:7f00:1::1" }]],
    ["public then unparseable", [{ address: "8.8.8.8" }, { address: "garbage" }]],
  ];
  for (const [name, answer] of mixed) {
    await check(`dns blocked (any address): ${name}`, () =>
      expectBlocked("https://multi.example/", stubLookup(answer).lookup),
    );
  }
  await check("dns allowed: mixed public A + AAAA", () =>
    expectAllowed(
      "https://images.pexels.example/photo.jpg",
      stubLookup([{ address: "104.18.20.1", family: 4 }, { address: "2606:4700::6812:1401", family: 6 }]).lookup,
    ),
  );

  // 4. Resolution failures fail closed.
  await check("dns fail-closed: lookup throws", () =>
    expectBlocked("https://nxdomain.example/", stubLookup(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })).lookup),
  );
  await check("dns fail-closed: empty answer", () => expectBlocked("https://empty.example/", stubLookup([]).lookup));

  // 5. Protocol and parse checks are unchanged.
  for (const url of ["file:///etc/passwd", "ftp://8.8.8.8/x", "gopher://8.8.8.8/", "data:text/plain,hi", "not a url", ""]) {
    await check(`blocked scheme/parse: ${JSON.stringify(url)}`, () => expectBlocked(url));
  }

  // 6. The default resolver (no stub) still resolves and classifies: localhost → loopback.
  await check("real resolver: http://localhost/ is refused", async () => {
    await assert.rejects(() => assertSafeFetchUrl("http://localhost:3000/"), UnsafeUrlError);
    assert.equal(await isSafeFetchUrl("http://localhost:3000/"), false);
  });

  if (failures.length) {
    console.error(`verify-safe-fetch: ${failures.length} FAILED, ${passed} passed`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`verify-safe-fetch: ${passed}/${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
