import { NextRequest, NextResponse } from "next/server";
import { getIncident, getZones, updateZone } from "@/lib/firebase";
import { generateJSON } from "@/lib/gemini";

type ReasonRequestBody = {
  incident_id?: unknown;
};

type ZoneDocument = Record<string, unknown> & {
  id: string;
};

type ResourceInventory = Record<string, number>;

type ReasonedZone = {
  zone_id: string;
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

function normalizeAssignedResources(
  value: unknown,
  inventory: ResourceInventory
): ResourceInventory {
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
  zoneIds: Set<string>,
  inventory: ResourceInventory
): ReasonedZone[] {
  const candidate = isRecord(value) ? value.zones : value;

  if (!Array.isArray(candidate)) {
    throw new Error("Gemini output must contain a zones array.");
  }

  const zones = candidate
    .filter(isRecord)
    .map((zone): ReasonedZone | null => {
      const zoneId = zone.zone_id;

      if (typeof zoneId !== "string" || !zoneIds.has(zoneId)) {
        return null;
      }

      return {
        zone_id: zoneId,
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
    throw new Error("Gemini output did not contain valid reasoned zones.");
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
  return `You are the Reasoning Agent for an AI Micro-Zone Disaster Intelligence & Resource Dispatcher.

Assign priorities, allocate limited resources, detect conflicts, and resolve conflicts logically.

Required JSON schema:
{
  "zones": [
    {
      "zone_id": "string",
      "priority_score": 1,
      "assigned_resources": {
        "resource_name": 0
      },
      "conflicts_detected": ["string"],
      "conflict_resolution": "string"
    }
  ]
}

Rules:
- Return exactly one JSON object matching the schema.
- Include every input zone exactly once using its id as zone_id.
- priority_score must be an integer from 1 to 10.
- assigned_resources must only use resources present in resource_inventory.
- Total assigned_resources across all zones must not exceed resource_inventory.
- Give scarce resources to higher-priority zones first.
- conflicts_detected must list resource shortages, contradictory needs, or severity-confidence issues.
- conflict_resolution must explain the final allocation decision.

resource_inventory:
${JSON.stringify(resourceInventory)}

zones:
${JSON.stringify(zones)}`;
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
    const zoneIds = new Set(zones.map((zone) => zone.id));
    const aiOutput = await generateJSON(
      buildReasoningPrompt(zones, resourceInventory)
    );
    const reasonedZones = normalizeReasonedZones(
      aiOutput,
      zoneIds,
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
