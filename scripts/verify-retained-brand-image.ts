import assert from "node:assert/strict";

async function main() {
  const {
    materializeRetainedBrandImage,
    retainedBrandImageAssetMeta,
  } = await import("../src/lib/retained-brand-image.server");

  const calls: string[] = [];
  const dependencies = {
    renderRoot: "/safe/renders",
    exists: (filePath: string) => filePath === "/safe/renders/existing.png",
    copy: (sourcePath: string, destinationPath: string) => { calls.push(`copy:${sourcePath}:${destinationPath}`); },
    download: async (url: string, destinationPath: string) => { calls.push(`download:${url}:${destinationPath}`); },
    renderKenBurns: async (imagePath: string, outputPath: string, durationSec?: number) => { calls.push(`kenburns:${imagePath}:${outputPath}:${durationSec ?? "default"}`); },
    validMp4: () => true,
    markNormalized: (filePath: string) => { calls.push(`marker:${filePath}`); },
  };
  const localAsset = { beatId: "beat-1", imageJobId: "image-1", outputUrl: "/api/renders/existing.png" };
  await materializeRetainedBrandImage({
    asset: localAsset,
    imagePath: "/work/reused.png",
    outputPath: "/work/reused.mp4",
    durationSec: 7,
  }, dependencies);
  assert.deepEqual(calls.slice(0, 2), [
    "copy:/safe/renders/existing.png:/work/reused.png",
    "kenburns:/work/reused.png:/work/reused.mp4:7",
  ]);
  assert.equal(calls.some((call) => call.startsWith("download:")), false);
  assert.deepEqual(retainedBrandImageAssetMeta(localAsset), {
    provider: "runpod",
    assetId: "image-1",
    downloadUrl: "/api/renders/existing.png",
    license: "Hero AI generated",
  });

  await assert.rejects(
    materializeRetainedBrandImage({
      asset: { beatId: "beat-2", imageJobId: null, outputUrl: "/api/renders/%2E%2E%2Fsecret.png" },
      imagePath: "/work/traversal.png",
      outputPath: "/work/traversal.mp4",
    }, dependencies),
    /invalid retained Brand Visual image path/,
  );

  calls.length = 0;
  await materializeRetainedBrandImage({
    asset: { beatId: "beat-3", imageJobId: null, outputUrl: "https://cdn.example.test/image.png" },
    imagePath: "/work/remote.png",
    outputPath: "/work/remote.mp4",
  }, dependencies);
  assert.equal(calls[0], "download:https://cdn.example.test/image.png:/work/remote.png");
  assert.equal(calls[1], "kenburns:/work/remote.png:/work/remote.mp4:default");

  await assert.rejects(
    materializeRetainedBrandImage({
      asset: localAsset,
      imagePath: "/work/invalid.png",
      outputPath: "/work/invalid.mp4",
    }, { ...dependencies, validMp4: () => false }),
    /Ken Burns output is invalid/,
  );
  console.log("verify-retained-brand-image: PASS local/remote materialization + traversal guard");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
