import { GoogleGenAI } from "@google/genai";

const GEMINI_MODEL = "gemini-2.5-flash";

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
    config: {
      maxOutputTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },  // disable thinking — JSON output must not be prefixed with thought text
    },
  });
  return response.text ?? "";
}
