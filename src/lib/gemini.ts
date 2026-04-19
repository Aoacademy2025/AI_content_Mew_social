import { GoogleGenAI } from "@google/genai";

const GEMINI_MODEL = "gemini-3-flash-preview";

export async function geminiGenerateText(
  apiKey: string,
  prompt: string,
  maxOutputTokens = 4096,
  temperature = 0,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { maxOutputTokens, temperature },
  });
  return response.text ?? "";
}
