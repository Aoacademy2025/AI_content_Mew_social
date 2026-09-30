export type ElevenLabsSpeechModel = "v3" | "v4";

/** Unknown or missing values stay on the model existing accounts already use. */
export function elevenLabsSpeechModel(value: unknown): ElevenLabsSpeechModel {
  return value === "v4" ? "v4" : "v3";
}

export function elevenLabsProviderModelId(model: ElevenLabsSpeechModel): "eleven_v3" | "eleven_v4" {
  return model === "v4" ? "eleven_v4" : "eleven_v3";
}
