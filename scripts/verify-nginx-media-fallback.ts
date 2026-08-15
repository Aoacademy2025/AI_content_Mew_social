import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
  path.join(process.cwd(), "deploy", "nginx.conf"),
  "utf8",
);

for (const location of [
  "location /renders/ {",
  "location ^~ /api/renders/ {",
  "location /stocks/ {",
  "location ^~ /api/stocks/ {",
]) {
  const start = source.indexOf(location);
  assert.notEqual(start, -1, `missing ${location}`);
  const end = source.indexOf("\n    }", start);
  assert.notEqual(end, -1, `unterminated ${location}`);
  const block = source.slice(start, end);
  assert.match(
    block,
    /try_files \$uri @media_storage_fallback;/,
    `${location} must fall through after a local miss`,
  );
}

const fallbackStart = source.indexOf("location @media_storage_fallback {");
assert.notEqual(fallbackStart, -1, "missing media storage fallback");
const fallbackEnd = source.indexOf("\n    }", fallbackStart);
assert.notEqual(fallbackEnd, -1, "unterminated media storage fallback");
const fallback = source.slice(fallbackStart, fallbackEnd);
assert.match(
  fallback,
  /rewrite \^\/\(\?:api\/\)\?\(renders\|stocks\)\/\(\.\*\)\$ \/api\/\$1\/\$2 break;/,
);
assert.match(fallback, /proxy_pass http:\/\/localhost:3000;/);
assert.match(fallback, /proxy_set_header x-heroai-service-secret "";/);
assert.match(fallback, /proxy_set_header x-heroai-act-as "";/);

console.log("PASS Nginx local media fast path with R2 fallback");
