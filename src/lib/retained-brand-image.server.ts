import "server-only";

import fs from "node:fs";
import path from "node:path";
import {
  applyKenBurns,
  downloadAndCrop,
  isValidMp4Path,
  normalizedMarkerPath,
} from "@/lib/broll-asset-lib";

export type RetainedBrandImage = {
  beatId: string;
  imageJobId: string | null;
  outputUrl: string;
};

type MaterializationDependencies = {
  renderRoot: string;
  exists: (filePath: string) => boolean;
  copy: (sourcePath: string, destinationPath: string) => void;
  download: typeof downloadAndCrop;
  renderKenBurns: typeof applyKenBurns;
  validMp4: typeof isValidMp4Path;
  markNormalized: (filePath: string) => void;
};

const defaultDependencies: MaterializationDependencies = {
  renderRoot: path.join(process.cwd(), "public", "renders"),
  exists: fs.existsSync,
  copy: fs.copyFileSync,
  download: downloadAndCrop,
  renderKenBurns: applyKenBurns,
  validMp4: isValidMp4Path,
  markNormalized: (filePath) => { try { fs.writeFileSync(filePath, ""); } catch {} },
};

export function retainedBrandImageAssetMeta(asset: RetainedBrandImage) {
  return {
    provider: "runpod",
    assetId: asset.imageJobId ?? asset.beatId,
    downloadUrl: asset.outputUrl,
    license: "Hero AI generated",
  } as const;
}

/** Materialize one already-paid Brand Visual image as a fresh Ken Burns clip.
 * Local persisted URLs are path-validated and copied; remote retained URLs use
 * the existing bounded download/crop helper. No provider or settlement call is
 * reachable through this seam. */
export async function materializeRetainedBrandImage(
  input: {
    asset: RetainedBrandImage;
    imagePath: string;
    outputPath: string;
    durationSec?: number;
  },
  dependencies: MaterializationDependencies = defaultDependencies,
): Promise<void> {
  if (input.asset.outputUrl.startsWith("/api/renders/")) {
    const encoded = input.asset.outputUrl.slice("/api/renders/".length);
    const filename = decodeURIComponent(encoded);
    if (!filename || path.basename(filename) !== filename) {
      throw new Error("invalid retained Brand Visual image path");
    }
    const sourcePath = path.join(dependencies.renderRoot, filename);
    if (!dependencies.exists(sourcePath)) {
      throw new Error("retained Brand Visual image is missing");
    }
    dependencies.copy(sourcePath, input.imagePath);
  } else {
    await dependencies.download(input.asset.outputUrl, input.imagePath);
  }
  await dependencies.renderKenBurns(input.imagePath, input.outputPath, input.durationSec);
  if (!dependencies.validMp4(input.outputPath)) {
    throw new Error("retained Brand Visual Ken Burns output is invalid");
  }
  dependencies.markNormalized(normalizedMarkerPath(input.outputPath));
}
