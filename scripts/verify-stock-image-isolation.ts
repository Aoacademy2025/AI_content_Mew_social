import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createStockImagePrefix } from "../src/lib/stock-image-paths";
import { materializeRetainedBrandImage } from "../src/lib/retained-brand-image.server";
import { applyKenBurns, downloadAndCrop, isValidMp4Path } from "../src/lib/broll-asset-lib";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "stock-image-isolation-"));
  try {
    await Promise.all(["red", "blue"].map(background => sharp({ create: {
      width: 108, height: 192, channels: 3, background,
    } }).png().toFile(join(root, `${background}.png`))));
    // Two same-account jobs reuse scene 0 concurrently. Delay encoding until
    // BOTH source copies finish: this deterministically exposes shared paths.
    let copied = 0;
    let release!: () => void;
    const bothCopied = new Promise<void>(resolve => { release = resolve; });
    const paths = ["job-realistic", "job-comic"].map(job => {
      const prefix = createStockImagePrefix("owner", job);
      return { imagePath: join(root, `${prefix}2100000000.src.png`), outputPath: join(root, `${prefix}2100000000.mp4`) };
    });
    await Promise.all(paths.map((paths, i) => materializeRetainedBrandImage({
      asset: { beatId: `beat-${i}`, imageJobId: `image-${i}`, outputUrl: `/api/renders/${i ? "blue" : "red"}.png` },
      ...paths, durationSec: .2,
    }, {
      renderRoot: root, exists: existsSync, copy: copyFileSync,
      download: downloadAndCrop, validMp4: isValidMp4Path, markNormalized: file => writeFileSync(file, ""),
      renderKenBurns: async (source, output, duration) => {
        if (++copied === 2) release();
        await bothCopied;
        assert(readFileSync(source).equals(readFileSync(join(root, `${i ? "blue" : "red"}.png`))),
          "another job must not overwrite this scene before encoding");
        await applyKenBurns(source, output, duration);
      },
    })));
    assert.notEqual(paths[0].outputPath, paths[1].outputPath);
    const saved = readFileSync(paths[0].outputPath);
    // Retry/rerender of the SAME job gets fresh materialization, while the
    // original exported project's source remains byte-identical.
    const retryPrefix = createStockImagePrefix("owner", "job-realistic");
    const retryOutput = join(root, `${retryPrefix}2100000000.mp4`);
    assert.notEqual(retryOutput, paths[0].outputPath);
    await applyKenBurns(join(root, "blue.png"), retryOutput, .2);
    assert.deepEqual(readFileSync(paths[0].outputPath), saved);
    rmSync(retryOutput);
    assert(existsSync(paths[0].outputPath), "failed retry cleanup cannot remove an older project's source");
    assert.notEqual(createStockImagePrefix("owner"), createStockImagePrefix("owner"), "ad-hoc requests also isolate");
    // Guard the integration: every image branch (generated, retained, AutoMix,
    // free photo) shares this namespace; stock video caching retains its key.
    const route = readFileSync("src/app/api/videos/fetch-stock/route.ts", "utf8");
    assert(route.includes("createStockImagePrefix(userId, videoJobId)"));
    assert.equal((route.match(/const imageFile = `\$\{imagePrefix\}/g) ?? []).length, 7);
    assert.equal((route.match(/const outFile = `\$\{imagePrefix\}/g) ?? []).length, 7);
    assert.equal((route.match(/const outFile = `\$\{userPrefix\}/g) ?? []).length, 1);
    console.log("stock image isolation PASS: concurrent retained scenes, real ffmpeg, retry, cleanup, all image branches");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
