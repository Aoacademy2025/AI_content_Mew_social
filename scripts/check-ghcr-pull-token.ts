import dotenv from "dotenv";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length).trim();
}

dotenv.config({ path: argument("env-file") || ".env", override: false, quiet: true });

const username = process.env.GHCR_USERNAME?.trim();
const password = process.env.GHCR_PULL_TOKEN?.trim();
const image = argument("image")
  || process.env.RUNPOD_Z_IMAGE_IMAGE?.trim()
  || "ghcr.io/mewic/heroai-z-image-turbo:staging-20260721-bf16-d24c4cf";

if (!username || !password) throw new Error("GHCR_USERNAME and GHCR_PULL_TOKEN are required");

const match = image.match(/^ghcr\.io\/([^:]+):(.+)$/);
if (!match) throw new Error(`Unsupported GHCR image reference: ${image}`);
const repository = match[1];
const tag = match[2];
const manifestUrl = `https://ghcr.io/v2/${repository}/manifests/${encodeURIComponent(tag)}`;
const accept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function challengeValue(source: string, key: string): string | undefined {
  return source.match(new RegExp(`${key}="([^"]+)"`))?.[1];
}

async function main() {
  const githubResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${password}`,
      "User-Agent": "heroai-registry-preflight",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!githubResponse.ok) {
    throw new Error(`GHCR pull credential is not a valid GitHub credential (status ${githubResponse.status})`);
  }

  const challengeResponse = await fetch(manifestUrl, {
    method: "HEAD",
    headers: { Accept: accept },
    signal: AbortSignal.timeout(20_000),
  });
  const challenge = challengeResponse.headers.get("www-authenticate") || "";
  const realm = challengeValue(challenge, "realm");
  const service = challengeValue(challenge, "service");
  const scope = challengeValue(challenge, "scope");
  if (!realm || !service || !scope) {
    throw new Error(`GHCR registry challenge was missing (status ${challengeResponse.status})`);
  }

  const tokenUrl = new URL(realm);
  tokenUrl.searchParams.set("service", service);
  tokenUrl.searchParams.set("scope", scope);
  const tokenResponse = await fetch(tokenUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const tokenBody = await tokenResponse.json().catch(() => null) as
    | { token?: unknown; access_token?: unknown }
    | null;
  const registryToken = typeof tokenBody?.token === "string"
    ? tokenBody.token
    : typeof tokenBody?.access_token === "string"
      ? tokenBody.access_token
      : "";
  if (!tokenResponse.ok || !registryToken) {
    throw new Error(`GHCR pull scope exchange failed (status ${tokenResponse.status})`);
  }

  const manifestResponse = await fetch(manifestUrl, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${registryToken}`, Accept: accept },
    signal: AbortSignal.timeout(20_000),
  });
  if (!manifestResponse.ok) {
    throw new Error(`GHCR manifest pull failed (status ${manifestResponse.status})`);
  }
  console.log(JSON.stringify({
    ok: true,
    image,
    digest: manifestResponse.headers.get("docker-content-digest"),
    credential: "valid",
    pullScope: "valid",
  }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "GHCR preflight failed");
  process.exitCode = 1;
});
