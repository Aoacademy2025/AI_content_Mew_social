# Hero Voice persona shortlist proposal (T1)

**Status:** Proposal only. The app catalog code is untouched. This is a screening-data-driven
shortlist for Mew to confirm (or override) by listening before any catalog change ships.

> **Amendment 1 (controller, same day):** the original single-linkage clustering collapsed a
> 20-voice, mostly-female group into a single representative, defeating the plan's own
> gender/F0-spread preference (final mix landed at 3 female / 13 male). Re-clustered with
> complete-linkage — see "Method (round 1 fix)" below. Superseded by Amendment 2; kept as
> **Appendix A**.
>
> **Amendment 2 / round 2 (controller, same day):** review found that complete-linkage only
> guarantees cohesion *within* each clique — it never checked distinctness *across* the 9
> chosen representatives. 5 of those 9 turned out to be pairwise near-duplicates of each
> other by the project's own duplicate-REVIEW bar. Fixed by adding a hard **independent-set**
> constraint across the whole final list — see "Method (round 2 — final)" below. **The table
> in that section is the one to use.** Round-1's list is now Appendix B.

## Method (round 1 fix)

1. **Similarity clusters, attempt 1 (raised thresholds).** Per the amendment, first tried
   re-splitting the mega-cluster with a stricter single-linkage edge rule:
   `Resemblyzer ≥ 0.885 OR ECAPA ≥ 0.72` (both thresholds raised from the original
   0.86 / 0.70). Recomputed connected components over all 48 voices with this rule.
   Result: the blob shrank only slightly (20 → 17 members: `voice_17`, `voice_18`, `voice_45`
   dropped out) and was **still one blob** — raising the bar didn't break the chaining,
   because single-linkage chains through intermediate pairs regardless of where the bar
   sits, as long as *some* chain of edges above the bar still connects the group.
2. **Similarity clusters, attempt 2 (complete-linkage at original thresholds) — used.**
   Per the amendment's fallback instruction, switched to **complete-linkage** clustering at
   the *original* thresholds (`Resemblyzer ≥ 0.86 OR ECAPA ≥ 0.70`). Complete-linkage means
   a group is only merged into one cluster if *every pair* within it clears the threshold
   (i.e., the group is a clique in the 65-edge duplicate graph), not just a chain. Implemented
   as greedy maximal-clique-cover partitioning (networkx `find_cliques`, repeatedly take the
   largest remaining maximal clique, remove its members, repeat until all 48 voices are
   assigned — cliques of 1 are singletons). This is stricter and, unlike single-linkage,
   doesn't chain: it broke the 20-voice blob into three genuine cliques (sizes 5/4/4) plus 5
   singletons, and — as a side effect — also broke the original two smaller single-linkage
   clusters (B: 8 voices, C: 3 voices) into six 2-voice cliques plus one singleton, since
   those groups were themselves chains, not cliques, under the original thresholds.
   **Caveat:** greedy maximal-clique-cover is tie-break-dependent, not canonical — when
   multiple maximal cliques of the same size are available at a given step, the algorithm's
   iteration order decides which one gets taken, so a different (equally valid) run could
   partition the same 48 voices into a different-but-still-complete-linkage-valid set of
   cliques. The 9-clique structure below is *a* correct complete-linkage partition, not
   *the* unique one.
3. **Excluded outright (unchanged):** `voice_32`, `voice_33`, `voice_44`.
4. **One representative per resulting sub-cluster** — same preference order as the original
   task: CER 0%/0% → voiced fraction ≥ 0.6 → lower CER sum → F0-band spread / gender balance,
   with the same documented supplementary tiebreak (highest in-cluster degree within the
   *original* 65-edge graph, then higher voiced fraction) used only where the stated ladder
   still left an exact tie.
5. **Trim to ≤16, fix the deep-band-male over-representation.** Complete-linkage clustering
   plus exclusion yielded 29 candidate clusters (9 multi-voice + 20 singletons) — 9
   multi-cluster representatives were kept automatically (one per clique), and 7 of the 20
   singletons were promoted to reach 16 total. Per the amendment, the singleton selection
   deliberately corrected the earlier deep-band-male oversaturation: of 12 available
   deep-band (<130Hz) male singletons, only the 4 highest-voiced-fraction **accent-labeled**
   ones were kept (`voice_42` chinese, `voice_48` korean, `voice_27` british, `voice_38`
   canadian — voiced 0.87/0.85/0.79/0.73), dropping the weaker/generic ones (`voice_28`
   american 0.61, `voice_30` australian 0.68, `voice_25`/`voice_14`/`voice_01`/`voice_05`/
   `voice_24`/`voice_12` — all deep, unaccented, redundant with each other and with the kept
   accent voices). The remaining 3 of the 7 singleton slots went to non-deep, non-redundant
   voices: `voice_07` (child, high band), `voice_26` (elderly female, high band), `voice_47`
   (elderly female, mid-low band) — the highest-quality clusters left outside the deep-male
   glut, chosen to broaden band and gender coverage rather than duplicate it.

## Clustering result (complete-linkage, before exclusion/trim)

| Cluster | Size | Members |
| --- | ---: | --- |
| 1 | 5 | voice_16, 29, 31, 34, 41 |
| 2 | 4 | voice_02, 04, 08, 13 |
| 3 | 4 | voice_06, 10, 15, 36 |
| 4 | 2 | voice_09, 40 |
| 5 | 2 | voice_17, 18 |
| 6 | 2 | voice_39, 43 |
| 7 | 2 | voice_03, 46 |
| 8 | 2 | voice_11, 23 |
| 9 | 2 | voice_21, 37 |
| singleton | 1×23 | voice_01, 05, 07, 12, 14, 19, 20, 22, 24, 25, 26, 27, 28, 30, 32, 33, 35, 38, 42, 44, 45, 47, 48 |

Total: 5+4+4+2+2+2+2+2+2+23 = 48. ✓ (3 of the 23 singletons — `voice_32/33/44` — are the
excluded-outright voices.)

## Method (round 2 — final)

Complete-linkage guarantees every *chosen* clique is internally cohesive, but it says
nothing about distinctness **across** the 9 chosen representatives — two representatives
from different cliques can still be near-duplicates of each other if an edge happens to
cross clique boundaries (which is common near a mega-blob: the three cliques carved out of
the original 20-voice single-linkage blob are still densely interconnected with each other).
Round-2 review caught exactly this: 5 of the round-1 final 16 were pairwise duplicate-REVIEW
edges — `voice_41–voice_08`, `voice_41–voice_15`, `voice_41–voice_39`, `voice_08–voice_15`,
`voice_46–voice_37` (the `41–39` pair clears **both** Resemblyzer ≥0.86 and ECAPA ≥0.70, the
others clear Resemblyzer only). Ironically, this same "not-a-duplicate-of-what's-already-in"
check was already being applied when deciding not to promote `voice_45`/`voice_20` — it just
hadn't been applied to the cluster **representatives** themselves.

**Fix — hard independent-set constraint.** Added the rule: the final persona set must be an
independent set in the 65-edge duplicate-REVIEW graph (no two chosen voices may share an
edge). Re-picked representatives only inside the two regions that had conflicts, everything
else unchanged:

- **Region 1 (mega-blob remnants):** cliques 1/2/3 (5/4/4 voices, all originally part of the
  20-voice single-linkage blob) plus clique 6 (`voice_39`/`voice_43`) are all
  cross-connected. Brute-forced all 5×4×4×2 = 160 combinations of one pick per clique,
  filtered to the 25 that are internally conflict-free, then ranked by (a) all four
  CER-perfect, (b) highest summed voiced fraction. Considered the amendment's explicit
  question — keep `voice_41` (the hub, highest individual voiced fraction) and swap its
  neighbors, or drop `voice_41` — and **dropped `voice_41`**: every conflict-free,
  all-CER-perfect combination that includes `voice_41` requires clique 3 to fall back to a
  non-CER-perfect member (voice_41 has a direct edge to `voice_15`, clique 3's only
  CER-perfect voice, and to both CER-perfect clique-2 candidates `voice_02`/`voice_08`).
  Dropping `voice_41` instead lets clique 3 keep `voice_15` and clique 2 keep a CER-perfect
  member, which the reverse choice cannot achieve. Result: `voice_31` (clique 1, female
  australian accent, was runner-up to `voice_41` on voiced fraction), `voice_13` (clique 2,
  middle-aged female), `voice_15` (clique 3, unchanged), `voice_43` (clique 6, female
  chinese accent, swapped in for `voice_39` which has a direct edge to `voice_31`/`voice_34`/
  `voice_41`). All four are CER-perfect; picked over the marginally-higher-voiced
  `voice_34`+`voice_13`+`voice_15`+`voice_43` combo to keep an accent label (australian)
  instead of a generic one — a 0.015 voiced-fraction difference against a real label-diversity
  gain.
- **Region 2:** clique 7 (`voice_03`/`voice_46`) vs. clique 9 (`voice_21`/`voice_37`) —
  `voice_37`–`voice_46` is an edge. `voice_21`–`voice_46` is not, and `voice_21` is
  CER-perfect (same as `voice_37`, just 0.03 lower voiced fraction), so swapped
  `voice_37` → `voice_21` and kept `voice_46` — no quality cost, conflict resolved.
- **Regions 3–5 (cliques 4, 5, 8) and all 7 singletons:** unaffected — none of their voices
  had an edge to any other chosen representative, verified by checking all
  C(16,2) = 120 pairs of the new 16 against the full 65-edge set.

**Result: 0 remaining duplicate-adjacent pairs** — the final 16 is now a verified
independent set. (No "ear-check these pairs" caveat is needed since the hard constraint was
satisfiable without sacrificing the 12–16 count, gender balance, or band spread — see
composition below, unchanged from round 1's 7F/8M/1-neutral, mid-high7/deep4/mid-low3/high2.)

**Doc-honesty correction on `voice_45`/`voice_20`** (round-1 said only "lower
priority/weaker quality"; the real reasons, re-verified against the round-2 final 16):
- `voice_45` (young adult female, very low pitch, CER 0%/0%, voiced 0.886): its only
  duplicate-edge was to `voice_41`, which round 2 dropped — so `voice_45` is **not**
  edge-blocked against the current final 16. It stays unpromoted purely on redundancy/
  balance grounds: the list already carries 5 mid-high female voices
  (`voice_31, 13, 15, 18, 43`), and `voice_45` (also mid-high female) wouldn't add
  band/gender coverage the list doesn't already have.
- `voice_20` (female, moderate pitch, CER 3.8%/5.8%): **is still edge-blocked** — it has a
  direct duplicate-REVIEW edge to `voice_15`, which is in the final 16 in both rounds. Its
  nonzero CER (the worst of any promoted/considered singleton) would have excluded it on
  quality grounds regardless, but the decisive, structural reason is the edge to `voice_15`.

## Final 16-persona shortlist (round 2 — this is the current, correct list)

| Persona | Sub-cluster represented | F0 (Hz) | Band | CER ref/preview | Voiced | Rationale |
| --- | --- | ---: | --- | --- | ---: | --- |
| voice_31 | 5-clique (16, 29, 31, 34, 41) | 198.3 | mid-high | 0.00% / 0.00% | 0.85 | Round-2 pick (was voice_41 — dropped, see above). CER-perfect, conflict-free with all other final picks. Female, australian accent. |
| voice_13 | 4-clique (02, 04, 08, 13) | 207.1 | mid-high | 0.00% / 0.00% | 0.89 | Round-2 pick (was voice_08 — had an edge to voice_15 and to voice_31's clique). CER-perfect, conflict-free. Middle-aged female. |
| voice_15 | 4-clique (06, 10, 15, 36) | 258.7 | mid-high | 0.00% / 0.00% | 0.88 | Unchanged from round 1 — only CER-perfect member; still conflict-free once voice_41/voice_08 were removed. Elderly female, moderate pitch. |
| voice_40 | 2-clique (09, 40) | 148.6 | mid-low | 0.00% / 0.00% | 0.84 | Unchanged. Male, indian accent. |
| voice_18 | 2-clique (17, 18) | 248.5 | mid-high | 0.00% / 0.00% | 0.90 | Unchanged. Child, female. |
| voice_43 | 2-clique (39, 43) | 223.9 | mid-high | 0.00% / 0.00% | 0.82 | Round-2 pick (was voice_39 — had an edge to voice_31's clique). CER-perfect, conflict-free. Female, chinese accent. |
| voice_46 | 2-clique (03, 46) | 231.8 | mid-high | 0.00% / 0.00% | 0.83 | Unchanged. Middle-aged male, high pitch. |
| voice_11 | 2-clique (11, 23) | 134.7 | mid-low | 0.00% / 1.92% | 0.86 | Unchanged. Young adult male. |
| voice_21 | 2-clique (21, 37) | 220.1 | mid-high | 0.00% / 0.00% | 0.83 | Round-2 pick (was voice_37 — had an edge to voice_46). CER-perfect, conflict-free, only 0.03 lower voiced fraction than voice_37. Teenager male, high pitch. |
| voice_07 | singleton | 345.3 | high | 0.00% / 0.00% | 0.89 | Unchanged. Child (gender-neutral label). |
| voice_26 | singleton | 389.9 | high | 0.00% / 1.92% | 0.90 | Unchanged. Elderly female, high pitch. |
| voice_47 | singleton | 174.2 | mid-low | 0.00% / 0.00% | 0.84 | Unchanged. Elderly female, very low pitch. |
| voice_42 | singleton | 124.2 | deep | 0.00% / 0.00% | 0.87 | Unchanged. Male, chinese accent. |
| voice_48 | singleton | 98.3 | deep | 0.00% / 0.00% | 0.85 | Unchanged. Male, korean accent. |
| voice_27 | singleton | 96.3 | deep | 0.00% / 0.00% | 0.79 | Unchanged. Male, british accent. |
| voice_38 | singleton | 93.3 | deep | 0.00% / 0.00% | 0.73 | Unchanged. Male, canadian accent. |

**Verified independent set:** all C(16,2) = 120 pairs checked against the 65-edge
duplicate-REVIEW graph — **0 edges found**. No "ear-check these pairs" caveat needed.

**Excluded outright (rule 2, unchanged):** `voice_32`, `voice_33`, `voice_44`.

### Final composition (round 2, unchanged from round 1 in aggregate)

- **Gender:** 7 female (`voice_31, 13, 15, 18, 43, 26, 47`) / 8 male
  (`voice_40, 46, 11, 21, 42, 48, 27, 38`) / 1 gender-neutral label (`voice_07`, "child").
- **F0 band:** mid-high 7, deep 4, mid-low 3, high 2.
- Total: 16.

---

## Appendix B — round-1 (complete-linkage, pre-independent-set) 16-list, superseded

| Persona | Sub-cluster represented | F0 (Hz) | Band | CER ref/preview | Voiced | Rationale |
| --- | --- | ---: | --- | --- | ---: | --- |
| voice_41 | 5-clique (16, 29, 31, 34, 41) | 230.5 | mid-high | 0.00% / 0.00% | 0.91 | Of the 4 CER-perfect members (16 fails on preview CER), highest voiced fraction. Female, indian accent. |
| voice_08 | 4-clique (02, 04, 08, 13) | 239.3 | mid-high | 0.00% / 0.00% | 0.91 | All 4 CER-perfect; highest voiced fraction. Teenager, female. |
| voice_15 | 4-clique (06, 10, 15, 36) | 258.7 | mid-high | 0.00% / 0.00% | 0.88 | Only member with CER 0%/0% (06, 36 fail preview; 10 fails reference). Elderly female, moderate pitch. |
| voice_40 | 2-clique (09, 40) | 148.6 | mid-low | 0.00% / 0.00% | 0.84 | Only CER-perfect member (09 has 7.7% preview CER). Male, indian accent — accent-pairs with voice_41. |
| voice_18 | 2-clique (17, 18) | 248.5 | mid-high | 0.00% / 0.00% | 0.90 | Only CER-perfect member (17 fails both CER checks). Child, female. |
| voice_39 | 2-clique (39, 43) | 193.8 | mid-high | 0.00% / 0.00% | 0.83 | Both CER-perfect; marginally higher voiced fraction than voice_43 (0.83 vs 0.82). Female, canadian accent. |
| voice_46 | 2-clique (03, 46) | 231.8 | mid-high | 0.00% / 0.00% | 0.83 | Only CER-perfect member (03 has 5.8% reference CER). Middle-aged male, high pitch. |
| voice_11 | 2-clique (11, 23) | 134.7 | mid-low | 0.00% / 1.92% | 0.86 | Neither member is CER-perfect; voice_11 has the lower CER sum (1.9% vs 3.8%) and higher voiced fraction. Young adult male. |
| voice_37 | 2-clique (21, 37) | 233.2 | mid-high | 0.00% / 0.00% | 0.86 | Both CER-perfect; higher voiced fraction than voice_21 (0.86 vs 0.83). Elderly male, high pitch. |
| voice_07 | singleton | 345.3 | high | 0.00% / 0.00% | 0.89 | No dedup match at any threshold; clean CER. Fills the high band, gender-neutral label ("child"). |
| voice_26 | singleton | 389.9 | high | 0.00% / 1.92% | 0.90 | No dedup match; only elderly-female high-band candidate. Minor preview CER kept — best available for that combination. |
| voice_47 | singleton | 174.2 | mid-low | 0.00% / 0.00% | 0.84 | No dedup match; clean CER. Elderly female, very low pitch — broadens mid-low/female coverage. |
| voice_42 | singleton | 124.2 | deep | 0.00% / 0.00% | 0.87 | Highest voiced fraction among the 6 accent-labeled deep-band male singletons. Chinese accent. |
| voice_48 | singleton | 98.3 | deep | 0.00% / 0.00% | 0.85 | 2nd-highest voiced fraction among accent-labeled deep-band males. Korean accent. |
| voice_27 | singleton | 96.3 | deep | 0.00% / 0.00% | 0.79 | 3rd-highest voiced fraction among accent-labeled deep-band males. British accent. |
| voice_38 | singleton | 93.3 | deep | 0.00% / 0.00% | 0.73 | 4th-highest voiced fraction among accent-labeled deep-band males. Canadian accent. |

**Deliberately dropped deep-band male accent singletons (weakest of the group, by voiced
fraction):** `voice_28` american accent (0.61), `voice_30` australian accent (0.68).

**Deliberately dropped deep-band male non-accent singletons (redundant with kept picks and
with each other):** `voice_25`, `voice_14`, `voice_01`, `voice_05`, `voice_24`, `voice_12`.

**Also not promoted (lower priority / weaker quality than what was kept):** `voice_22`,
`voice_35`, `voice_19` (mid-low male, `voice_19` also has nonzero CER), `voice_45`, `voice_20`
(mid-high female, `voice_20` has nonzero CER on both ref/preview — weakest overall singleton).

**Excluded outright (rule 2, unchanged):** `voice_32`, `voice_33`, `voice_44`.

### Final composition

- **Gender:** 7 female (`voice_41, 08, 15, 18, 39, 26, 47`) / 8 male
  (`voice_40, 46, 11, 37, 42, 48, 27, 38`) / 1 gender-neutral label (`voice_07`, "child").
- **F0 band:** mid-high 7, deep 4, mid-low 3, high 2.
- Total: 16.

This is a substantially more balanced mix than the original single-linkage result (3F/13M,
10/16 deep-band) while still respecting every fixed rule (CER/voiced/CER-sum preference
order, 12–16 target, outright exclusions) and the deep-band accent voices that remain are
the strongest 4 of the available 6, not an arbitrary cut.

---

## Appendix A — original single-linkage 16-list (superseded, kept for traceability)

This was the first proposal, built with plain single-linkage (transitive-closure) clustering
at the original thresholds. It is **superseded** by both later rounds, but kept here so the
reasoning trail is auditable.

| Persona | Cluster members represented | F0 (Hz) | Band | CER ref/preview | Voiced | Rationale |
| --- | --- | ---: | --- | --- | ---: | --- |
| voice_41 | 20-voice Cluster A (02,04,06,07,08,10,13,15,16,17,18,20,29,31,34,36,39,41,43,45) | 230.5 | mid-high | 0.00% / 0.00% | 0.91 | Highest in-cluster degree (11) among the CER-perfect subset of the 20-voice chain; highest voiced fraction tiebreak vs. voice_29 (also degree 11). Female, indian accent. |
| voice_37 | 8-voice Cluster B (01,03,11,21,23,35,37,46) | 233.2 | mid-high | 0.00% / 0.00% | 0.86 | Highest in-cluster degree (3) among CER-perfect candidates. Elderly male, high pitch. |
| voice_40 | 3-voice Cluster C (09,14,40) | 148.6 | mid-low | 0.00% / 0.00% | 0.84 | Tiebreak over voice_14 (deep-band, redundant with voice_25) — fills mid-low band, accent-pairs with voice_41. Male, indian accent. |
| voice_05 | singleton | 119.3 | deep | 0.00% / 0.00% | 0.81 | No dedup match at threshold; clean CER. Male, very low pitch. |
| voice_12 | singleton | 112.6 | deep | 0.00% / 0.00% | 0.61 | No dedup match; voiced fraction at the 0.6 floor but passes. Middle-aged male, plain. |
| voice_22 | singleton | 143.5 | mid-low | 0.00% / 0.00% | 0.78 | No dedup match; clean CER. Young adult male, low pitch. |
| voice_24 | singleton | 120.7 | deep | 0.00% / 0.00% | 0.83 | No dedup match; clean CER. Middle-aged male, very low pitch. |
| voice_25 | singleton | 112.6 | deep | 0.00% / 0.00% | 0.88 | No dedup match; clean CER, strong voiced fraction. Elderly male, very low pitch. |
| voice_26 | singleton | 389.9 | high | 0.00% / 1.92% | 0.90 | Only high-band female candidate; minor preview CER kept (still best available for that band). Elderly female, high pitch. |
| voice_27 | singleton | 96.3 | deep | 0.00% / 0.00% | 0.79 | No dedup match; clean CER. Male, british accent. |
| voice_28 | singleton | 125.3 | deep | 0.00% / 0.00% | 0.61 | No dedup match; voiced fraction at the 0.6 floor but passes. Male, american accent. |
| voice_30 | singleton | 115.9 | deep | 0.00% / 0.00% | 0.68 | No dedup match; clean CER. Male, australian accent. |
| voice_38 | singleton | 93.3 | deep | 0.00% / 0.00% | 0.73 | No dedup match; clean CER. Male, canadian accent. |
| voice_42 | singleton | 124.2 | deep | 0.00% / 0.00% | 0.87 | No dedup match; clean CER, strong voiced fraction. Male, chinese accent. |
| voice_47 | singleton | 174.2 | mid-low | 0.00% / 0.00% | 0.84 | No dedup match; clean CER. Elderly female, very low pitch. |
| voice_48 | singleton | 98.3 | deep | 0.00% / 0.00% | 0.85 | No dedup match; clean CER, strong voiced fraction. Male, korean accent. |

Dropped for the 12–16 trim: `voice_19`. Gender mix: 3 female / 13 male — this imbalance is
what triggered the amendment.
