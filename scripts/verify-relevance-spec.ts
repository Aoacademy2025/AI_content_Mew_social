// Unit tests for src/lib/relevance-spec.ts (run: npx tsx scripts/verify-relevance-spec.ts)
import {
  parseRelevanceSpec, specToTerms, profileToTerms,
  scoreCandidateSoft, shouldDistrustRanker,
} from "../src/lib/relevance-spec";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// parse: valid JSON (with ```json fence) → spec
const good = parseRelevanceSpec('```json\n{"visualDomain":"consumer drones","positiveConcepts":["Drone","quadcopter"],"avoidConcepts":["medical"],"safeFallbackQueries":["drone flying sky","quadcopter close up"]}\n```');
check("parse: valid → spec", !!good);
check("parse: positives lowercased + trimmed", good?.positiveConcepts.includes("drone") === true);
check("parse: keeps avoid + fallback", (good?.avoidConcepts[0] === "medical") && (good?.safeFallbackQueries.length === 2));

// parse: malformed / empty / no signal → null
check("parse: not JSON → null", parseRelevanceSpec("the mood is dark and dramatic") === null);
check("parse: empty → null", parseRelevanceSpec("") === null);
check("parse: JSON with no positive+no fallback → null", parseRelevanceSpec('{"visualDomain":"x","avoidConcepts":["y"]}') === null);

// specToTerms
const terms = specToTerms(good!);
check("specToTerms: shape", Array.isArray(terms.positive) && Array.isArray(terms.avoid) && Array.isArray(terms.fallbackQueries) && typeof terms.domainLabel === "string");
check("specToTerms: domainLabel from visualDomain", terms.domainLabel === "consumer drones");

// profileToTerms (fallback bridge) — uses broll-profile exports
const pt = profileToTerms("news_crime");
check("profileToTerms: news_crime has positive terms", pt.positive.length > 0);
check("profileToTerms: news_crime has reject terms as avoid", pt.avoid.length > 0);
check("profileToTerms: general → empty-ish but valid shape", Array.isArray(profileToTerms("general").positive));

// ── soft scoring: penalize but NEVER eliminate ──
const droneTerms = { positive: ["drone", "quadcopter", "aerial"], avoid: ["medical", "hospital"], fallbackQueries: [], domainLabel: "consumer drones" };
const droneClip = scoreCandidateSoft("drone flying over field aerial", "โดรนบินสูง", droneTerms);
const medicalClip = scoreCandidateSoft("doctor in hospital surgery", "โดรนบินสูง", droneTerms);
check("soft: on-domain clip scores higher than off-domain", droneClip > medicalClip, `drone=${droneClip} medical=${medicalClip}`);
check("soft: off-domain clip is penalized but still a finite number (not eliminated)", Number.isFinite(medicalClip));
// best-of all-off-domain is still selectable (max score exists, nothing dropped)
const allOff = [scoreCandidateSoft("cat playing", "โดรน", droneTerms), scoreCandidateSoft("city street", "โดรน", droneTerms)];
check("soft: even all-off-domain yields a best (non-empty selection)", Math.max(...allOff) !== -Infinity);

// ── ranker distrust: ≥80% of -1 → distrust ──
check("distrust: 9/10 rejected → distrust", shouldDistrustRanker([0,-1,-1,-1,-1,-1,-1,-1,-1,-1], 80) === true);
check("distrust: 5/10 rejected → trust", shouldDistrustRanker([0,1,2,3,4,-1,-1,-1,-1,-1], 80) === false);
check("distrust: empty results → distrust", shouldDistrustRanker([], 80) === true);

console.log(failures === 0 ? "\n✅ ALL RELEVANCE-SPEC CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
