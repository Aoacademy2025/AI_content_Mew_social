/**
 * verify-managed-stock-cache-key — the managed-stock 24h search cache must be
 * keyed by the B-roll preference variant too (F7, wave 0 task 4).
 *
 * Before this, "เน้นไทย"/"Cinematic" changed the search query for some queries
 * but two different preferences could still collide on one cached answer, so a
 * re-render inside 24h returned byte-identical clips. `variant` closes that.
 * An EMPTY variant must keep the legacy key so a deploy does not cold-start the
 * whole cache (a burst of live Pexels/Pixabay calls) for no-preference jobs.
 */
import assert from "node:assert/strict";

import { stockSearchCacheKey } from "../src/lib/managed-stock";

const base = { query: "night street", perPage: 15, minDuration: 3 };
assert.notEqual(stockSearchCacheKey(base), stockSearchCacheKey({ ...base, variant: "s=cinematic" }));
assert.equal(stockSearchCacheKey(base), stockSearchCacheKey({ ...base, variant: "" }));
console.log("verify-managed-stock-cache-key: ok");
