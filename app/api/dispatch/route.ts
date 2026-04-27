import { NextRequest, NextResponse } from "next/server";
import { getZones, updateZone } from "@/lib/firebase";
import { generateJSON } from "@/lib/ollama";

type DispatchRequestBody = {
  incident_id?: unknown;
};

type ZoneDocument = Record<string, unknown> & {
  id: string;
};

type DispatchedZone = {
  zone_id: string;
  zone_name: string;
  dispatch_brief: string;
};

type FinalZoneOutput = ZoneDocument & {
  dispatch_brief: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getZoneName(zone: ZoneDocument): string {
  return typeof zone.zone_name === "string" && zone.zone_name.trim()
    ? zone.zone_name.trim()
    : zone.id;
}

function normalizeZoneName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDispatchedZones(
  value: unknown,
  zoneIdByName: Map<string, string>
): DispatchedZone[] {
  const candidate = isRecord(value) ? value.zones : value;

  if (!Array.isArray(candidate)) {
    throw new Error("Ollama output must contain an array of dispatch briefs.");
  }

  const zones = candidate
    .filter(isRecord)
    .map((zone): DispatchedZone | null => {
      const zoneName = zone.zone_name;
      const dispatchBrief = zone.dispatch_brief;

      if (
        typeof zoneName !== "string" ||
        typeof dispatchBrief !== "string"
      ) {
        return null;
      }

      const normalizedZoneName = zoneName.trim();
      const zoneId = zoneIdByName.get(normalizeZoneName(normalizedZoneName));
      const normalizedBrief = dispatchBrief.trim();

      if (!normalizedZoneName || !zoneId || !normalizedBrief) {
        return null;
      }

      return {
        zone_id: zoneId,
        zone_name: normalizedZoneName,
        dispatch_brief: normalizedBrief
      };
    })
    .filter((zone): zone is DispatchedZone => zone !== null);

  if (zones.length === 0) {
    throw new Error("Ollama output did not contain valid dispatch briefs.");
  }

  return zones;
}

function buildDispatchPrompt(zones: ZoneDocument[]): string {
  return `You are generating real-world disaster response briefs.

Return ONLY valid JSON.

Input:
${JSON.stringify(zones)}

For each zone:
- Describe situation clearly
- Explain urgency
- Mention assigned resources
- Keep it concise but realistic

Output:
[
  {
    "zone_name": "string",
    "dispatch_brief": "string"
  }
]`;
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

    const zoneIdByName = new Map(
      zones.map((zone) => [normalizeZoneName(getZoneName(zone)), zone.id])
    );
    const aiOutput = await generateJSON(buildDispatchPrompt(zones));
    const dispatchedZones = normalizeDispatchedZones(aiOutput, zoneIdByName);
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
