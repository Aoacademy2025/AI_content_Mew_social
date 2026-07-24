# Hero Voice persona shortlist proposal (T1)

**Status:** Proposal only. The app catalog code is untouched. This is a screening-data-driven
shortlist for Mew to confirm (or override) by listening before any catalog change ships.

> **Amendment (controller, same day):** the original single-linkage clustering collapsed a
> 20-voice, mostly-female group into a single representative, defeating the plan's own
> gender/F0-spread preference (final mix landed at 3 female / 13 male). Re-clustered per the
> controller's fix — see "Method (revised)" below. The original single-linkage 16-list is
> kept as an **Appendix** at the bottom for traceability.

## Method (revised)

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

## Final 16-persona shortlist (revised — use this one)

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

## Appendix — original single-linkage 16-list (superseded, kept for traceability)

This was the first proposal, built with plain single-linkage (transitive-closure) clustering
at the original thresholds. It is **superseded** by the revised list above per the
controller's amendment, but kept here so the reasoning trail is auditable.

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
