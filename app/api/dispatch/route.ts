import { NextRequest, NextResponse } from "next/server";
import { getZones, updateZone } from "@/lib/firebase";
import { generateJSON } from "@/lib/gemini";

type DispatchRequestBody = {
  incident_id?: unknown;
};

type ZoneDocument = Record<string, unknown> & {
  id: string;
};

type DispatchedZone = {
  zone_id: string;
  dispatch_brief: string;
};

type FinalZoneOutput = ZoneDocument & {
  dispatch_brief: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDispatchedZones(
  value: unknown,
  zoneIds: Set<string>
): DispatchedZone[] {
  const candidate = isRecord(value) ? value.zones : value;

  if (!Array.isArray(candidate)) {
    throw new Error("Gemini output must contain a zones array.");
  }

  const zones = candidate
    .filter(isRecord)
    .map((zone): DispatchedZone | null => {
      const zoneId = zone.zone_id;
      const dispatchBrief = zone.dispatch_brief;

      if (
        typeof zoneId !== "string" ||
        !zoneIds.has(zoneId) ||
        typeof dispatchBrief !== "string"
      ) {
        return null;
      }

      const normalizedBrief = dispatchBrief.trim();

      if (!normalizedBrief) {
        return null;
      }

      return {
        zone_id: zoneId,
        dispatch_brief: normalizedBrief
      };
    })
    .filter((zone): zone is DispatchedZone => zone !== null);

  if (zones.length === 0) {
    throw new Error("Gemini output did not contain valid dispatch briefs.");
  }

  return zones;
}

function buildDispatchPrompt(zones: ZoneDocument[]): string {
  return `You are the Dispatch Agent for an AI Micro-Zone Disaster Intelligence & Resource Dispatcher.

Generate concise, human-readable dispatch briefs for responders using the allocation data for each zone.

Required JSON schema:
{
  "zones": [
    {
      "zone_id": "string",
      "dispatch_brief": "string"
    }
  ]
}

Rules:
- Return exactly one JSON object matching the schema.
- Include every input zone exactly once using its id as zone_id.
- Each dispatch_brief must mention the zone name, priority score, assigned resources, conflicts, and immediate action.
- Do not invent resources that are not present in assigned_resources.
- Do not include markdown.
- Keep each brief operational and concise.

zones:
${JSON.stringify(zones)}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DispatchRequestBody;
    const incidentId = body.incident_id;

    if (typeof incidentId !== "string" || !incidentId.trim()) {
      return NextResponse.json(
        { error: "incident_id must be a non-empty string." },
        { status: 400 }
      );
    }

    const zones = await getZones(incidentId);

    if (zones.length === 0) {
      return NextResponse.json(
        { error: "No zones found for this incident." },
        { status: 404 }
      );
    }

    const zoneIds = new Set(zones.map((zone) => zone.id));
    const aiOutput = await generateJSON(buildDispatchPrompt(zones));
    const dispatchedZones = normalizeDispatchedZones(aiOutput, zoneIds);
    const briefsByZoneId = new Map(
      dispatchedZones.map((zone) => [zone.zone_id, zone.dispatch_brief])
    );

    await Promise.all(
      dispatchedZones.map((zone) =>
        updateZone(incidentId, zone.zone_id, {
          dispatch_brief: zone.dispatch_brief
        })
      )
    );

    const finalZones: FinalZoneOutput[] = zones.map((zone) => ({
      ...zone,
      dispatch_brief: briefsByZoneId.get(zone.id) ?? ""
    }));

    return NextResponse.json({
      incident_id: incidentId,
      zones: finalZones
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate dispatch.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
