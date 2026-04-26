"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, type DocumentData } from "firebase/firestore";
import { db } from "@/lib/firebase";

type ZoneListProps = {
  incidentId: string;
};

type Zone = {
  id: string;
  zone_name: string;
  severity: string;
  priority_score: number | null;
  assigned_resources: Record<string, number>;
  dispatch_brief: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeNumber(value: unknown): number | null {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeAssignedResources(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([resourceName, quantity]) => {
        const numberValue =
          typeof quantity === "number"
            ? quantity
            : typeof quantity === "string"
              ? Number(quantity)
              : Number.NaN;

        return [
          resourceName,
          Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0
        ] as const;
      })
      .filter(([, quantity]) => quantity > 0)
  );
}

function normalizeZone(id: string, data: DocumentData): Zone {
  return {
    id,
    zone_name: normalizeString(data.zone_name, "Unnamed zone"),
    severity: normalizeString(data.severity, "unknown"),
    priority_score: normalizeNumber(data.priority_score),
    assigned_resources: normalizeAssignedResources(data.assigned_resources),
    dispatch_brief: normalizeString(data.dispatch_brief, "")
  };
}

function formatResourceName(value: string): string {
  return value.replaceAll("_", " ");
}

function severityClasses(severity: string): string {
  switch (severity.toLowerCase()) {
    case "critical":
      return "border-red-200 bg-red-50 text-red-800";
    case "high":
      return "border-orange-200 bg-orange-50 text-orange-800";
    case "medium":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "low":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    default:
      return "border-zinc-200 bg-zinc-50 text-zinc-700";
  }
}

export function ZoneList({ incidentId }: ZoneListProps) {
  const [zones, setZones] = useState<Zone[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(incidentId));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!incidentId.trim()) {
      setZones([]);
      setIsLoading(false);
      setError("");
      return;
    }

    setIsLoading(true);
    setError("");

    const zonesRef = collection(db, "incidents", incidentId, "zones");
    const unsubscribe = onSnapshot(
      zonesRef,
      (snapshot) => {
        const nextZones = snapshot.docs.map((zoneSnapshot) =>
          normalizeZone(zoneSnapshot.id, zoneSnapshot.data())
        );

        setZones(nextZones);
        setIsLoading(false);
      },
      (snapshotError) => {
        setError(snapshotError.message);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [incidentId]);

  const orderedZones = useMemo(
    () =>
      [...zones].sort((left, right) => {
        const leftPriority = left.priority_score ?? 0;
        const rightPriority = right.priority_score ?? 0;

        if (rightPriority !== leftPriority) {
          return rightPriority - leftPriority;
        }

        return left.zone_name.localeCompare(right.zone_name);
      }),
    [zones]
  );

  return (
    <section className="border-t border-zinc-200 pt-6">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-xl font-semibold text-zinc-950">Live zones</h2>
          <p className="mt-1 break-all text-sm text-zinc-600">
            Incident {incidentId}
          </p>
        </div>
        <span className="w-fit rounded-md border border-teal-200 bg-teal-50 px-2 py-1 text-sm font-medium text-teal-800">
          {isLoading ? "Listening..." : `${orderedZones.length} zones`}
        </span>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {!isLoading && !error && orderedZones.length === 0 && (
        <p className="mt-4 rounded-md border border-zinc-200 bg-white px-3 py-3 text-sm text-zinc-600">
          No zones detected yet.
        </p>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {orderedZones.map((zone) => (
          <article
            key={zone.id}
            className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-zinc-950">
                  {zone.zone_name}
                </h3>
                <span
                  className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-medium capitalize ${severityClasses(
                    zone.severity
                  )}`}
                >
                  {zone.severity}
                </span>
              </div>
              <span className="w-fit rounded-md border border-zinc-200 px-2 py-1 text-sm font-medium text-zinc-700">
                Priority {zone.priority_score ?? "pending"}
              </span>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium text-zinc-800">
                Assigned resources
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.keys(zone.assigned_resources).length > 0 ? (
                  Object.entries(zone.assigned_resources).map(
                    ([resourceName, quantity]) => (
                      <span
                        key={resourceName}
                        className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-sm text-zinc-700"
                      >
                        {formatResourceName(resourceName)}: {quantity}
                      </span>
                    )
                  )
                ) : (
                  <span className="text-sm text-zinc-500">Pending</span>
                )}
              </div>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium text-zinc-800">
                Dispatch brief
              </p>
              <p className="mt-2 text-sm leading-6 text-zinc-700">
                {zone.dispatch_brief || "Pending dispatch brief."}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
