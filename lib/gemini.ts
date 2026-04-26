import { GoogleGenerativeAI } from "@google/generative-ai";

function getGeminiModel() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  return genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      responseMimeType: "application/json"
    }
  });
}

function stripMarkdownFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJSONSafely(value: string): unknown {
  const cleaned = stripMarkdownFence(value);

  try {
    return JSON.parse(cleaned);
  } catch {
    const objectStart = cleaned.indexOf("{");
    const objectEnd = cleaned.lastIndexOf("}");
    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");

    const objectCandidate =
      objectStart >= 0 && objectEnd > objectStart
        ? cleaned.slice(objectStart, objectEnd + 1)
        : "";
    const arrayCandidate =
      arrayStart >= 0 && arrayEnd > arrayStart
        ? cleaned.slice(arrayStart, arrayEnd + 1)
        : "";

    const candidate =
      arrayCandidate && (!objectCandidate || arrayStart < objectStart)
        ? arrayCandidate
        : objectCandidate;

    if (!candidate) {
      throw new Error("Gemini response did not contain valid JSON.");
    }

    try {
      return JSON.parse(candidate);
    } catch {
      throw new Error("Gemini response contained malformed JSON.");
    }
  }
}

export async function generateJSON(prompt: string): Promise<unknown> {
  if (!prompt.trim()) {
    throw new Error("Prompt is required.");
  }

  try {
    const model = getGeminiModel();
    const result = await model.generateContent([
      `${prompt}

Return only valid JSON. Do not include markdown, comments, or prose.`
    ]);

    const responseText = result.response.text();

    if (!responseText.trim()) {
      throw new Error("Gemini returned an empty response.");
    }

    return parseJSONSafely(responseText);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Gemini JSON generation failed: ${error.message}`);
    }

    throw new Error("Gemini JSON generation failed with an unknown error.");
  }
}
