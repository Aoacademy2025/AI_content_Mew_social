import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

type TrustedLogo = {
  src: string;
  position:
    | "top-left"
    | "top-center"
    | "top-right"
    | "middle-left"
    | "center"
    | "middle-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
  sizePct: number;
  opacity: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
};

type NormalizeTrustedLogo = (
  value: unknown,
) => TrustedLogo | null | undefined;

const failures: string[] = [];

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${detail}`);
    console.error(`not ok - ${name}\n  ${detail}`);
  }
}

const validLogo: TrustedLogo = {
  src: "/api/renders/logo-snapshot-123e4567-e89b-42d3-a456-426614174000.webp",
  position: "bottom-right",
  sizePct: 18,
  opacity: 0.9,
  intrinsicWidth: 1600,
  intrinsicHeight: 900,
};

async function main() {
  process.env.DATABASE_URL ??= "file:/tmp/heroai-logo-render-verifier.db";
  const logoExport = await import("../src/lib/logo-export.server");
  const normalize = (
    logoExport as typeof logoExport & {
      normalizeTrustedLogoRenderInput?: NormalizeTrustedLogo;
    }
  ).normalizeTrustedLogoRenderInput;

  await check("trusted render input is normalized into the internal shape", () => {
    assert.equal(
      typeof normalize,
      "function",
      "normalizeTrustedLogoRenderInput is not exported",
    );
    assert.deepEqual(
      normalize({ ...validLogo, enabled: true, assetId: "must-not-survive" }),
      validLogo,
    );
    assert.equal(normalize(undefined), undefined, "an absent logo must stay absent");
  });

  await check("only flat random WebP render snapshots are accepted", () => {
    assert.equal(typeof normalize, "function");
    const rejectedSources = [
      "/api/renders/logo-snapshot-not-a-uuid.webp",
      "/api/renders/logo-snapshot-123e4567-e89b-12d3-a456-426614174000.webp",
      "/api/renders/nested/logo-snapshot-123e4567-e89b-42d3-a456-426614174000.webp",
      "/api/renders/../logo-snapshot-123e4567-e89b-42d3-a456-426614174000.webp",
      "/api/renders/%2e%2e/logo-snapshot-123e4567-e89b-42d3-a456-426614174000.webp",
      "https://example.com/logo-snapshot-123e4567-e89b-42d3-a456-426614174000.webp",
      "/api/brand-assets/asset-123/image",
      "/api/renders/logo-snapshot-123e4567-e89b-42d3-a456-426614174000.png",
      `${validLogo.src}?download=1`,
    ];
    for (const src of rejectedSources) {
      assert.equal(normalize({ ...validLogo, src }), null, `accepted unsafe src: ${src}`);
    }
  });

  await check("trusted dimensions, positions, and scalar bounds are strict", () => {
    assert.equal(typeof normalize, "function");
    assert.deepEqual(
      normalize({ ...validLogo, sizePct: 8, opacity: 0.2 }),
      { ...validLogo, sizePct: 8, opacity: 0.2 },
    );
    assert.deepEqual(
      normalize({ ...validLogo, sizePct: 35, opacity: 1 }),
      { ...validLogo, sizePct: 35, opacity: 1 },
    );

    const malformed = [
      { ...validLogo, position: "lower-right" },
      { ...validLogo, sizePct: 7.99 },
      { ...validLogo, sizePct: 35.01 },
      { ...validLogo, sizePct: Number.NaN },
      { ...validLogo, opacity: 0.19 },
      { ...validLogo, opacity: 1.01 },
      { ...validLogo, opacity: Number.POSITIVE_INFINITY },
      { ...validLogo, intrinsicWidth: undefined },
      { ...validLogo, intrinsicHeight: undefined },
      { ...validLogo, intrinsicWidth: 0 },
      { ...validLogo, intrinsicHeight: -1 },
      { ...validLogo, intrinsicWidth: 1.5 },
      null,
      [],
    ];
    for (const value of malformed) {
      assert.equal(normalize(value), null, `accepted malformed input: ${JSON.stringify(value)}`);
    }
  });

  const renderFileSource = readFileSync(
    path.join(process.cwd(), "src", "app", "api", "renders", "[filename]", "route.ts"),
    "utf8",
  );
  await check("the render file route serves WebP with image/webp", () => {
    assert.match(renderFileSource, /\bwebp:\s*["']image\/webp["']/);
  });

  const compositionSource = readFileSync(
    path.join(process.cwd(), "src", "remotion", "SubtitleOverlayComposition.tsx"),
    "utf8",
  );
  await check("the logo layer is above video and below subtitle sequences", () => {
    const videoIndex = compositionSource.indexOf("<OffthreadVideo");
    const logoIndex = compositionSource.indexOf('data-logo-overlay="true"');
    const subtitleIndex = compositionSource.indexOf("keywordPopups.map");
    assert.ok(videoIndex >= 0, "OffthreadVideo marker is absent");
    assert.ok(logoIndex >= 0, "trusted logo layer marker is absent");
    assert.ok(subtitleIndex >= 0, "subtitle map marker is absent");
    assert.ok(videoIndex < logoIndex, "logo must render after OffthreadVideo");
    assert.ok(logoIndex < subtitleIndex, "logo must render before subtitles");
  });

  const renderRouteSource = readFileSync(
    path.join(process.cwd(), "src", "app", "api", "videos", "render", "route.ts"),
    "utf8",
  );
  await check("direct render rejects malformed or missing trusted logo snapshots", () => {
    assert.match(renderRouteSource, /normalizeTrustedLogoRenderInput/);
    assert.match(
      renderRouteSource,
      /error:\s*["']invalid_logo_overlay["'][\s\S]{0,160}status:\s*400/,
    );
    assert.match(renderRouteSource, /logoOverlayPath[\s\S]{0,500}existsSync/);
  });

  if (failures.length > 0) {
    throw new Error(`logo-render verifier failed (${failures.length}):\n${failures.join("\n")}`);
  }
  console.log("logo-render: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
