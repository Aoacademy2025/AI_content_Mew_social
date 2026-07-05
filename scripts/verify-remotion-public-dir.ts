import fs from "fs";
import path from "path";
import { prepareRemotionBundlePublicDir } from "../src/lib/render/remotion-public-dir";

function check(name: string, condition: boolean) {
  if (!condition) {
    throw new Error(`FAIL: ${name}`);
  }
  console.log(`PASS: ${name}`);
}

const publicDir = prepareRemotionBundlePublicDir();
const source = path.join(process.cwd(), "public", "watermark.png");
const target = path.join(publicDir, "watermark.png");

check("returns remotion-public dir", publicDir.endsWith(path.join(".tmp", "remotion-public")));
check("source watermark exists", fs.existsSync(source));
check("target watermark exists", fs.existsSync(target));
check("target watermark size matches source", fs.statSync(target).size === fs.statSync(source).size);
