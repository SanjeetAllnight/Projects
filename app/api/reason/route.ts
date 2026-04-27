import { NextRequest, NextResponse } from "next/server";
import { getIncident, getZones, updateZone } from "@/lib/firebase";
import { generateJSON } from "@/lib/ollama";

type ReasonRequestBody = {
  incident_id?: unknown;
};

type ZoneDocument = Record<string, unknown> & {
  id: string;
};

type ResourceInventory = Record<string, number>;

type ReasonedZone = {
  zone_id: string;
  zone_name: string;
  priority_score: number;
  assigned_resources: ResourceInventory;
  conflicts_detected: string[];
  conflict_resolution: string;
};

type UpdatedZone = ReasonedZone & {
  assigned_resources: ResourceInventory;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResourceInventory(value: unknown): ResourceInventory {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([resourceName, quantity]) => {
        const normalizedQuantity =
          typeof quantity === "number"
            ? quantity
            : typeof quantity === "string"
              ? Number(quantity)
              : Number.NaN;

        return [
          resourceName.trim(),
          Number.isFinite(normalizedQuantity)
            ? Math.max(0, Math.floor(normalizedQuantity))
            : 0
        ] as const;
      })
      .filter(([resourceName, quantity]) => resourceName && quantity > 0)
  );
}

function getResourceInventory(incident: Record<string, unknown>): ResourceInventory {
  return normalizeResourceInventory(
    incident.resource_inventory ?? incident.resources ?? incident.inventory
  );
}

function getZoneName(zone: ZoneDocument): string {
  return typeof zone.zone_name === "string" && zone.zone_name.trim()
    ? zone.zone_name.trim()
    : zone.id;
}

function normalizeZoneName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePriorityScore(value: unknown): number {
  const score =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(score)) {
    return 1;
  }

  return Math.min(Math.max(Math.round(score), 1), 10);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeResourceKey(
  value: string,
  inventory: ResourceInventory
): string | null {
  const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]/g, "");

  return (
    Object.keys(inventory).find((resourceName) => {
      const normalizedResource = resourceName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

      return (
        normalizedValue.includes(normalizedResource) ||
        normalizedResource.includes(normalizedValue) ||
        normalizedValue.includes(normalizedResource.replace(/s$/, "")) ||
        normalizedResource.replace(/s$/, "").includes(normalizedValue)
      );
    }) ?? null
  );
}

function quantityFromResourceLabel(value: string): number {
  const match = value.match(/\d+/);

  if (!match) {
    return 1;
  }

  return Math.max(1, Math.floor(Number(match[0])));
}

function normalizeAssignedResources(
  value: unknown,
  inventory: ResourceInventory
): ResourceInventory {
  if (Array.isArray(value)) {
    return value.reduce<ResourceInventory>((resources, item) => {
      if (typeof item !== "string") {
        return resources;
      }

      const resourceName = normalizeResourceKey(item, inventory);

      if (!resourceName) {
        return resources;
      }

      resources[resourceName] =
        (resources[resourceName] ?? 0) + quantityFromResourceLabel(item);

      return resources;
    }, {});
  }

  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([resourceName, quantity]) => {
        const normalizedQuantity =
          typeof quantity === "number"
            ? quantity
            : typeof quantity === "string"
              ? Number(quantity)
              : Number.NaN;

        return [
          resourceName.trim(),
          Number.isFinite(normalizedQuantity)
            ? Math.max(0, Math.floor(normalizedQuantity))
            : 0
        ] as const;
      })
      .filter(
        ([resourceName, quantity]) =>
          resourceName in inventory && quantity > 0
      )
  );
}

function normalizeReasonedZones(
  value: unknown,
  zoneIdByName: Map<string, string>,
  inventory: ResourceInventory
): ReasonedZone[] {
  const candidate = isRecord(value) ? value.allocations ?? value.zones : value;

  if (!Array.isArray(candidate)) {
    throw new Error("Ollama output must contain an allocations array.");
  }

  const zones = candidate
    .filter(isRecord)
    .map((zone): ReasonedZone | null => {
      const zoneName = zone.zone_name;

      if (typeof zoneName !== "string") {
        return null;
      }

      const normalizedZoneName = zoneName.trim();
      const zoneId = zoneIdByName.get(normalizeZoneName(normalizedZoneName));

      if (!normalizedZoneName || !zoneId) {
        return null;
      }

      return {
        zone_id: zoneId,
        zone_name: normalizedZoneName,
        priority_score: normalizePriorityScore(zone.priority_score),
        assigned_resources: normalizeAssignedResources(
          zone.assigned_resources,
          inventory
        ),
        conflicts_detected: normalizeStringArray(zone.conflicts_detected),
        conflict_resolution:
          typeof zone.conflict_resolution === "string"
            ? zone.conflict_resolution.trim()
            : ""
      };
    })
    .filter((zone): zone is ReasonedZone => zone !== null);

  if (zones.length === 0) {
    throw new Error("Ollama output did not contain valid allocations.");
  }

  return zones;
}

function enforceResourceLimits(
  zones: ReasonedZone[],
  inventory: ResourceInventory
): UpdatedZone[] {
  const remaining: ResourceInventory = { ...inventory };
  const orderedZones = [...zones].sort(
    (left, right) => right.priority_score - left.priority_score
  );

  return orderedZones.map((zone) => {
    const assignedResources: ResourceInventory = {};
    const conflicts = new Set(zone.conflicts_detected);

    for (const [resourceName, requestedQuantity] of Object.entries(
      zone.assigned_resources
    )) {
      const availableQuantity = remaining[resourceName] ?? 0;
      const allocatedQuantity = Math.min(requestedQuantity, availableQuantity);

      if (allocatedQuantity > 0) {
        assignedResources[resourceName] = allocatedQuantity;
        remaining[resourceName] = availableQuantity - allocatedQuantity;
      }

      if (allocatedQuantity < requestedQuantity) {
        conflicts.add(
          `${resourceName} allocation reduced from ${requestedQuantity} to ${allocatedQuantity} due to inventory limits.`
        );
      }
    }

    const conflictsDetected = Array.from(conflicts);

    return {
      ...zone,
      assigned_resources: assignedResources,
      conflicts_detected: conflictsDetected,
      conflict_resolution:
        conflictsDetected.length > 0 && !zone.conflict_resolution
          ? "Resources were assigned by priority score until inventory limits were reached."
          : zone.conflict_resolution
    };
  });
}

function buildReasoningPrompt(
  zones: ZoneDocument[],
  resourceInventory: ResourceInventory
): string {
  return `You are an AI disaster resource allocation engine.

Return ONLY valid JSON.

Input:
Zones:
${JSON.stringify(zones)}

Resources:
${JSON.stringify(resourceInventory)}

Tasks:
1. Assign priority_score (1-10)
2. Allocate LIMITED resources (respect constraints strictly)
3. Detect conflicts (same resource needed in multiple zones)
4. Resolve conflicts using:
   - severity
   - urgency
   - human risk

IMPORTANT:
- You MUST NOT assign more resources than available
- You MUST explain trade-offs
- Prioritize human life over infrastructure

Output:
{
  "allocations": [
    {
      "zone_name": "string",
      "priority_score": number,
      "assigned_resources": ["string"],
      "conflicts_detected": ["string"],
      "conflict_resolution": "string"
    }
  ]
}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ReasonRequestBody;
    const incidentId = body.incident_id;

    if (typeof incidentId !== "string" || !incidentId.trim()) {
      return NextResponse.json(
        { error: "incident_id must be a non-empty string." },
        { status: 400 }
      );
    }

    const incident = await getIncident(incidentId);

    if (!incident) {
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404 }
      );
    }

    const zones = await getZones(incidentId);

    if (zones.length === 0) {
      return NextResponse.json(
        { error: "No zones found for this incident." },
        { status: 404 }
      );
    }

    const resourceInventory = getResourceInventory(incident);
    const zoneIdByName = new Map(
      zones.map((zone) => [normalizeZoneName(getZoneName(zone)), zone.id])
    );
    const aiOutput = await generateJSON(
      buildReasoningPrompt(zones, resourceInventory)
    );
    const reasonedZones = normalizeReasonedZones(
      aiOutput,
      zoneIdByName,
      resourceInventory
    );
    const updatedZones = enforceResourceLimits(reasonedZones, resourceInventory);

    await Promise.all(
      updatedZones.map((zone) =>
        updateZone(incidentId, zone.zone_id, {
          priority_score: zone.priority_score,
          assigned_resources: zone.assigned_resources,
          conflicts_detected: zone.conflicts_detected,
          conflict_resolution: zone.conflict_resolution
        })
      )
    );

    return NextResponse.json({ zones: updatedZones });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reason over zones.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
