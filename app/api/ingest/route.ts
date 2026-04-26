import { NextRequest, NextResponse } from "next/server";
import { addZone } from "@/lib/firebase";
import { generateJSON } from "@/lib/gemini";

type IngestRequestBody = {
  raw_reports?: unknown;
  incident_id?: unknown;
};

type ExtractedZone = {
  zone_name: string;
  severity: string;
  needs: string[];
  confidence: number;
};

type SavedZone = ExtractedZone & {
  id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNeeds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((need): need is string => typeof need === "string")
    .map((need) => need.trim())
    .filter(Boolean);
}

function normalizeConfidence(value: unknown): number {
  const confidence =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(confidence)) {
    return 0;
  }

  return Math.min(Math.max(confidence, 0), 1);
}

function normalizeZone(value: unknown): ExtractedZone | null {
  if (!isRecord(value)) {
    return null;
  }

  const zoneName = value.zone_name;
  const severity = value.severity;

  if (typeof zoneName !== "string" || typeof severity !== "string") {
    return null;
  }

  const normalizedZone: ExtractedZone = {
    zone_name: zoneName.trim(),
    severity: severity.trim(),
    needs: normalizeNeeds(value.needs),
    confidence: normalizeConfidence(value.confidence)
  };

  if (!normalizedZone.zone_name || !normalizedZone.severity) {
    return null;
  }

  return normalizedZone;
}

function extractZones(value: unknown): ExtractedZone[] {
  const candidate = isRecord(value) ? value.zones : value;

  if (!Array.isArray(candidate)) {
    throw new Error("Gemini output must be an array of zones.");
  }

  const zones = candidate
    .map((zone) => normalizeZone(zone))
    .filter((zone): zone is ExtractedZone => zone !== null);

  if (zones.length === 0) {
    throw new Error("Gemini output did not contain any valid zones.");
  }

  return zones;
}

function buildIngestionPrompt(rawReports: string): string {
  return `You are the Ingestion Agent for an AI Micro-Zone Disaster Intelligence & Resource Dispatcher.

Extract disaster micro-zones from the raw reports.

Required JSON schema:
{
  "zones": [
    {
      "zone_name": "string",
      "severity": "low | medium | high | critical",
      "needs": ["string"],
      "confidence": 0.0
    }
  ]
}

Rules:
- Return exactly one JSON object matching the schema.
- severity must be one of: low, medium, high, critical.
- confidence must be a number from 0 to 1.
- needs must be an array of concise resource or response needs.
- Do not include locations or zones that are not supported by the reports.

Raw reports:
${rawReports}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as IngestRequestBody;
    const rawReports = body.raw_reports;
    const incidentId = body.incident_id;

    if (typeof rawReports !== "string" || !rawReports.trim()) {
      return NextResponse.json(
        { error: "raw_reports must be a non-empty string." },
        { status: 400 }
      );
    }

    if (typeof incidentId !== "string" || !incidentId.trim()) {
      return NextResponse.json(
        { error: "incident_id must be a non-empty string." },
        { status: 400 }
      );
    }

    const aiOutput = await generateJSON(buildIngestionPrompt(rawReports));
    const extractedZones = extractZones(aiOutput);

    const zones: SavedZone[] = await Promise.all(
      extractedZones.map(async (zone) => {
        const id = await addZone(incidentId, zone);

        return {
          id,
          ...zone
        };
      })
    );

    return NextResponse.json({ zones });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to ingest reports.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
