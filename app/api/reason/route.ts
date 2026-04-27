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
  severity: "low" | "medium" | "high";
  priority_score: number;
  needs: string[];
  assigned_resources: ResourceInventory;
  conflicts_detected: string[];
  conflict_resolution: string;
  unfulfilled_needs: string[];
  confidence: number;
};

type GlobalSummary = {
  strategy: string;
  resource_usage: Record<string, { total: number; allocated: number; remaining: number }>;
  unfulfilled_zones_count: number;
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
        severity: (zone.severity?.toString().toLowerCase() as any) || "medium",
        priority_score: normalizePriorityScore(zone.priority_score),
        needs: normalizeStringArray(zone.needs),
        assigned_resources: normalizeAssignedResources(
          zone.assigned_resources,
          inventory
        ),
        conflicts_detected: normalizeStringArray(zone.conflicts_detected),
        conflict_resolution:
          typeof zone.conflict_resolution === "string"
            ? zone.conflict_resolution.trim()
            : "",
        unfulfilled_needs: normalizeStringArray(zone.unfulfilled_needs),
        confidence: typeof zone.confidence === "number" ? zone.confidence : 0.9
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
          : zone.conflict_resolution,
      unfulfilled_needs: zone.unfulfilled_needs
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

CRITICAL CONSTRAINTS:
- Resources are LIMITED and MUST NOT be exceeded
- Total allocated resources MUST be <= available resources
- If resources are insufficient, some zones MUST receive NO resources

CONFLICT DETECTION:
- If multiple zones require the same limited resource:
  - Populate "conflicts_detected"
  - Explicitly mention competing zones (e.g., "Riverside vs Industrial competing for ambulance")

TRADE-OFF REASONING:
- You MUST explain decisions: "Zone A prioritized over Zone B because..."
- Consider: severity, urgency, human life risk

UNFULFILLED NEEDS:
- Add field: "unfulfilled_needs": ["ambulance", "rescue_team", ...]
- This MUST list resources that could not be allocated to this zone

REALISM RULES:
- DO NOT allocate resources to all zones if supply is insufficient
- Some zones may receive ZERO resources
- Prioritize human life over infrastructure

Output:
{
  "global_summary": {
    "strategy": "string",
    "resource_usage": {
      "resource_name": { "total": number, "allocated": number, "remaining": number }
    },
    "unfulfilled_zones_count": number
  },
  "allocations": [
    {
      "zone_name": "string",
      "severity": "low" | "medium" | "high",
      "priority_score": number,
      "needs": ["string"],
      "assigned_resources": {"resource_name": number},
      "conflicts_detected": ["string"],
      "conflict_resolution": "string",
      "unfulfilled_needs": ["string"],
      "confidence": number
    }
  ]
}

STRICT RULES:
- No null/undefined fields
- No missing keys
- Always return valid JSON
- Maintain compatibility with frontend
- If a zone has no assigned resources, unfulfilled_needs MUST be explicit.`;
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

    // Soft validation: warn if AI over-allocated any resource
    const totalAllocated: Record<string, number> = {};
    for (const zone of updatedZones) {
      for (const [resource, qty] of Object.entries(zone.assigned_resources)) {
        totalAllocated[resource] = (totalAllocated[resource] ?? 0) + qty;
      }
    }
    for (const [resource, total] of Object.entries(totalAllocated)) {
      if (total > (resourceInventory[resource] ?? 0)) {
        console.warn(`AI over-allocated resources: ${resource} (allocated ${total}, available ${resourceInventory[resource]})`);
      }
    }

    await Promise.all(
      updatedZones.map((zone) =>
        updateZone(incidentId, zone.zone_id, {
          severity: zone.severity,
          priority_score: zone.priority_score,
          needs: zone.needs,
          assigned_resources: zone.assigned_resources,
          conflicts_detected: zone.conflicts_detected,
          conflict_resolution: zone.conflict_resolution,
          unfulfilled_needs: zone.unfulfilled_needs,
          confidence: zone.confidence
        })
      )
    );

    const globalSummary: GlobalSummary = (aiOutput as any).global_summary || {
      strategy: "Resources prioritized by severity and priority score.",
      resource_usage: {},
      unfulfilled_zones_count: updatedZones.filter(z => Object.keys(z.assigned_resources).length === 0).length
    };

    return NextResponse.json({ 
      zones: updatedZones,
      global_summary: globalSummary
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reason over zones.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
