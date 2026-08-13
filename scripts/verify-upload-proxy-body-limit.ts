import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

async function main() {
  const configModule = await import(pathToFileURL(`${process.cwd()}/next.config.ts`).href);
  const nextConfig = configModule.default;
  const configuredLimit = nextConfig.experimental?.proxyClientMaxBodySize;

  assert.equal(
    configuredLimit,
    "510mb",
    "Next.js proxy must preserve the full body for supported 500 MB uploads plus multipart overhead",
  );

  console.log("PASS authenticated upload proxy body-size contract");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
