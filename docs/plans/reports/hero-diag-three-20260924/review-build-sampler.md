# Tier 1 re-review — build sampler

Reviewed `5e335d538ac4c2030a1d45c4b944ad994e21727f` (fix `affab99c1dd8da5431c08fa0324c9507de102119`) over `fdc4b984a64592a15f35821023d7dbdb8655f2f9`.

## Result: clear

Prior blocker fixed. `scripts/build_memory_sampler.py:228-310` uses supported Node flags before `processChild.js`; command-line values override `NODE_OPTIONS`, worker-script arguments are ignored, malformed forms fail closed, and both hyphen/underscore aliases are covered. The final root stat read at `399-404` invalidates a sample if the root changes during later child reads.

No new medium/high finding: fixed/numeric output is private (`O_EXCL`/`O_NOFOLLOW`, `0600`); canaries cannot reach JSONL or CLI errors; child races produce null totals; KiB fields, limits, summary, and persistent-launch documentation remain correct. No build or production activation occurred.

Advisory: Node 26 rejects a space-separated CLI heap argument, though one fixture accepts it. Such a process cannot reach `processChild.js`; this does not affect observed data.

Independent blank-environment unittest: 14 passed; `py_compile` and `git diff --check` passed. Synthetic symlink output returned static exit 2 and left its target unchanged.
