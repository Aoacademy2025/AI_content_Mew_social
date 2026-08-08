import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nginx = readFileSync("deploy/nginx.conf", "utf8");

function locationBlock(header: string): string {
  const start = nginx.indexOf(header);
  assert.notEqual(start, -1, `missing Nginx location: ${header}`);

  const open = nginx.indexOf("{", start);
  assert.notEqual(open, -1, `missing opening brace: ${header}`);

  let depth = 0;
  for (let index = open; index < nginx.length; index += 1) {
    if (nginx[index] === "{") depth += 1;
    if (nginx[index] === "}") depth -= 1;
    if (depth === 0) return nginx.slice(start, index + 1);
  }

  assert.fail(`unterminated Nginx location: ${header}`);
}

const uploadHeader = "location ~ ^/api/(?:videos/(?:upload-avatar|upload|broll-window/upload)|music/upload)$ {";
const upload = locationBlock(uploadHeader);

assert.match(upload, /proxy_request_buffering off;/, "large authenticated uploads must reach Clerk before the request token expires");
assert.match(upload, /proxy_http_version 1\.1;/, "request streaming requires HTTP\/1.1 upstream support");
assert.match(upload, /if \(-f \/var\/www\/ai-content\/\.deploy-maintenance\)/, "upload route must honor the deploy barrier");
assert.match(upload, /proxy_set_header x-heroai-service-secret "";/, "upload route must strip internal service auth");
assert.match(upload, /proxy_set_header x-heroai-act-as "";/, "upload route must strip account impersonation headers");

for (const pathFragment of [
  "upload-avatar",
  "|upload|",
  "broll-window/upload",
  "music/upload",
]) {
  assert.ok(uploadHeader.includes(pathFragment), `streaming location must cover ${pathFragment}`);
}

const generic = locationBlock("location / {");
assert.doesNotMatch(generic, /proxy_request_buffering off;/, "request streaming must stay scoped to upload routes");

console.log("PASS authenticated upload request streaming contract");
