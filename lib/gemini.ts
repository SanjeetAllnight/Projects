import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function generateJSON(prompt: string): Promise<any> {
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents:
      prompt +
      "\n\nIMPORTANT: Respond with valid JSON only. No markdown, no backticks, no explanation. Raw JSON only."
  });

  const text = response.text ?? "";
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse Gemini JSON response: ${text}`);
  }
}
