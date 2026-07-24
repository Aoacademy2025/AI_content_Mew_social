// T5 (hv-emotion) — update THIS experiment's own template (ij8vpp52nf) to a new
// image, in place, then re-read to confirm. Never touches any other template
// or endpoint; hardcoded to the two IDs this experiment owns
// (template ij8vpp52nf / endpoint d66lniwmhsjt51 — production txvrmtzfc8au3b
// and every other staging endpoint are out of scope for this script).
import dotenv from "dotenv";

dotenv.config({ path: process.env.RUNPOD_ENV_FILE || ".env", quiet: true });

const API_BASE = "https://rest.runpod.io/v1";
const apiKey = process.env.RUNPOD_API_KEY?.trim();
if (!apiKey) throw new Error("RUNPOD_API_KEY is required");

const TEMPLATE_ID = "ij8vpp52nf"; // hv-emotion-v12-omnivoice-staging (this experiment's own)
const ENDPOINT_ID = "d66lniwmhsjt51"; // hv-emotion-v12-omnivoice-staging (this experiment's own)
const REGISTRY_AUTH_ID = "cmrusznvj000q25gsb3hdtjmk"; // existing read-only ghcr auth, unchanged

const NEW_IMAGE = process.argv[2];
if (!NEW_IMAGE) {
  throw new Error("usage: npx tsx scripts/update-hv-emotion-template.ts <new-image-ref>");
}

type Template = { id: string; name: string; imageName: string };

async function runpod<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const source = await response.text();
  let body: unknown;
  try {
    body = source ? JSON.parse(source) : null;
  } catch {
    throw new Error(`Runpod ${path} returned non-JSON status ${response.status}: ${source.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `Runpod ${path} failed with status ${response.status}: ${JSON.stringify(body)}`;
    throw new Error(message);
  }
  return body as T;
}

async function main() {
  const before = await runpod<Template>(`/templates/${TEMPLATE_ID}`);
  if (before.id !== TEMPLATE_ID) {
    throw new Error(`Refusing: unexpected template id ${before.id}, expected ${TEMPLATE_ID}`);
  }
  console.log(JSON.stringify({ event: "before", id: before.id, name: before.name, imageName: before.imageName }));

  if (before.imageName === NEW_IMAGE) {
    console.log(JSON.stringify({ event: "noop-already-current", id: before.id, imageName: before.imageName }));
    return;
  }

  const patched = await runpod<Template>(`/templates/${TEMPLATE_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      imageName: NEW_IMAGE,
      containerRegistryAuthId: REGISTRY_AUTH_ID,
    }),
  });
  console.log(JSON.stringify({ event: "patched", id: patched.id, name: patched.name, imageName: patched.imageName }));

  const after = await runpod<Template>(`/templates/${TEMPLATE_ID}`);
  if (after.imageName !== NEW_IMAGE) {
    throw new Error(`Verification failed: template ${TEMPLATE_ID} imageName is ${after.imageName}, expected ${NEW_IMAGE}`);
  }
  console.log(JSON.stringify({ event: "verified", id: after.id, name: after.name, imageName: after.imageName, endpointId: ENDPOINT_ID }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "template update failed");
  process.exit(1);
});
