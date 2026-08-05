// T5 (hv-emotion) — purge any queued/orphaned jobs on THIS experiment's own
// endpoint (d66lniwmhsjt51) after a client-side poll timeout, so an abandoned
// job doesn't keep running/billing unaccounted-for and doesn't collide with a
// later resubmission of the same (persona, label) key. Never touches any
// other endpoint (hardcoded ID, no argv override).
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

const ENDPOINT_ID = "d66lniwmhsjt51"; // hv-emotion-v12-omnivoice-staging (this experiment's own)

async function main() {
  const before = await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/health`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then((r) => r.json());
  console.log(JSON.stringify({ event: "health-before", health: before }));

  const purge = await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/purge-queue`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then((r) => r.json());
  console.log(JSON.stringify({ event: "purge-result", purge }));

  const after = await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/health`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then((r) => r.json());
  console.log(JSON.stringify({ event: "health-after", health: after }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "purge failed");
  process.exit(1);
});
