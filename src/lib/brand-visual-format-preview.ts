import previewManifest from "../../public/brand-visual-formats/manifest.json";

const hashByFormat = new Map(
  previewManifest.formats.map((format) => [format.id, format.sha256]),
);

/** Content-version public preview assets so an already-open /brands surface
 * cannot retain an old decoded image after a reviewed sample batch deploy. */
export function visualFormatPreviewUrl(formatId: string): string {
  const hash = hashByFormat.get(formatId);
  if (!hash) throw new Error(`Missing Visual Format preview manifest entry: ${formatId}`);
  return `/brand-visual-formats/${formatId}.webp?v=${hash.slice(0, 16)}`;
}
