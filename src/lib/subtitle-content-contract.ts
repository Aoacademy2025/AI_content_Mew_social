import { prepareHeroVoiceSpeechText } from "@/lib/hero-voice-speech";

export type SubtitleContentComparison =
  | { status: "equivalent"; presentationChanged: boolean }
  | { status: "content_mismatch"; captionIndex: number };

function canonicalVisibleText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "");
}

function canonicalSpokenContent(value: string): string {
  return prepareHeroVoiceSpeechText(value)
    .normalize("NFC")
    .toLocaleLowerCase("th")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

function canonicalAuthoredContent(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("th")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

/**
 * Compare editable subtitle text with the immutable Narration Master.
 * Presentation-only punctuation, whitespace, casing, and card boundaries are
 * allowed; a different spoken claim is not.
 */
export function compareSubtitleContentToNarration(
  narrationText: string,
  captions: readonly Pick<{ text: string }, "text">[],
): SubtitleContentComparison {
  const renderedText = captions.map((caption) => caption.text).join("");
  if (canonicalVisibleText(renderedText) === canonicalVisibleText(narrationText)) {
    return { status: "equivalent", presentationChanged: false };
  }

  const narrationContent = canonicalSpokenContent(narrationText);
  const renderedContent = canonicalSpokenContent(renderedText);
  const narrationAuthoredContent = canonicalAuthoredContent(narrationText);
  const renderedAuthoredContent = canonicalAuthoredContent(renderedText);

  if (
    renderedAuthoredContent === narrationAuthoredContent
    && renderedContent === narrationContent
  ) {
    return {
      status: "equivalent",
      presentationChanged: canonicalVisibleText(renderedText) !== canonicalVisibleText(narrationText),
    };
  }

  let renderedPrefix = "";
  for (let index = 0; index < captions.length; index += 1) {
    renderedPrefix += captions[index].text;
    if (
      !narrationAuthoredContent.startsWith(canonicalAuthoredContent(renderedPrefix))
      || !narrationContent.startsWith(canonicalSpokenContent(renderedPrefix))
    ) {
      return { status: "content_mismatch", captionIndex: index };
    }
  }

  return {
    status: "content_mismatch",
    captionIndex: Math.max(0, captions.length - 1),
  };
}
