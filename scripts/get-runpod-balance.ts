// T5 (hv-emotion) — read-only prepaid RunPod balance check (before/after spend tracking).
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

async function main() {
  const response = await fetch("https://api.runpod.io/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "query { myself { clientBalance } }" }),
  });
  const body = await response.json();
  console.log(JSON.stringify(body));
}
main();
