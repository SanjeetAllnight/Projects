type OllamaGenerateResponse = {
  response?: string;
};

const OLLAMA_URL = "http://localhost:11434/api/generate";
const OLLAMA_MODEL = "gemma3:4b";

function cleanOutput(value: string): string {
  return value.replace(/```json|```/g, "").trim();
}

function extractJSONSubstring(value: string): string | null {
  const cleaned = cleanOutput(value);
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);

  return match?.[0] ?? null;
}

function parseJSON(value: string): unknown {
  const cleaned = cleanOutput(value);

  try {
    return JSON.parse(cleaned);
  } catch {
    const extracted = extractJSONSubstring(cleaned);

    if (!extracted) {
      throw new Error("Ollama response did not contain JSON.");
    }

    return JSON.parse(extracted);
  }
}

async function callOllama(prompt: string): Promise<string> {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with status ${response.status}.`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  const text = data.response ?? "";

  console.log("OLLAMA RAW:", text);

  return text;
}

export async function generateJSON(prompt: string) {
  if (!prompt.trim()) {
    throw new Error("Prompt is required.");
  }

  const firstOutput = await callOllama(prompt);

  try {
    return parseJSON(firstOutput);
  } catch {
    const retryOutput = await callOllama(
      `${prompt}

Previous output was invalid JSON:
${firstOutput}

Fix your output. Return ONLY valid JSON.`
    );

    try {
      return parseJSON(retryOutput);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to parse Ollama JSON response: ${error.message}`);
      }

      throw new Error("Failed to parse Ollama JSON response.");
    }
  }
}
