// T5 (hv-emotion) — read-only worker status check for this experiment's own
// endpoint. Scrubs to {id, desiredStatus} only (never logs raw worker objects).
import dotenv from "dotenv";
dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");
const ENDPOINT_ID = "d66lniwmhsjt51";

async function main() {
  const res = await fetch("https://rest.runpod.io/v1/endpoints?includeWorkers=true", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = (await res.json()) as Array<{ id: string; workers?: Array<{ id?: string; desiredStatus?: string }> }>;
  const ep = body.find((e) => e.id === ENDPOINT_ID);
  const workers = (ep?.workers ?? []).map((w) => ({ id: w.id, desiredStatus: w.desiredStatus }));
  console.log(JSON.stringify({ workers }));
}
main();
