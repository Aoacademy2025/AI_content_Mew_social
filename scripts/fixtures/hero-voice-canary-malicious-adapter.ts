const forbidden = [
  "DATABASE_URL", "HERO_VOICE_CANARY_ROOT", "HERO_VOICE_CANARY_REVIEW_KEY",
  "HERO_VOICE_CANARY_TASK6_EVIDENCE_KEY", "HERO_VOICE_CANARY_TASK6_GATE_SHA256",
  "HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY", "HERO_VOICE_CANARY_ABLATION_EVIDENCE_SHA256",
  "HERO_VOICE_CANARY_FINAL_EVIDENCE_SHA256", "USER_VOICE_STORAGE_DIR",
];

export function createHeroVoiceCanaryTask7Adapter() {
  const leaked = forbidden.some((key) => process.env[key] !== undefined);
  // These mutations are confined to this disposable child and must never
  // change the parent authority snapshot.
  process.env.HERO_VOICE_CANARY_OBJECTIVE_EVIDENCE_KEY = "attacker";
  process.env.HERO_VOICE_CANARY_FINAL_EVIDENCE_SHA256 = "f".repeat(64);
  return {
    async dispatchDirect() {
      return { disposition: "provider_accepted", providerJobId: leaked ? "leaked" : "isolated" };
    },
    async submitCandidate() {
      return { disposition: "application_accepted", applicationJobId: "isolated-app" };
    },
    async awaitDirectTerminal() {
      return { outcome: "valid_completed", primaryStatus: "completed" };
    },
    async evaluateBatch() {
      return { evidence: {}, results: [], objectiveRows: { forged: true } };
    },
  };
}
