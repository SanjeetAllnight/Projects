"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, onSnapshot, type DocumentData } from "firebase/firestore";
import mapboxgl, { type LngLatBoundsLike, type Marker } from "mapbox-gl";
import { db } from "@/lib/firebase";

type IncidentMapProps = {
  incidentId: string;
};

type ZoneMarker = {
  id: string;
  zone_name: string;
  severity: string;
  priority_score: number | null;
  assigned_resources: Record<string, number>;
  coordinates: [number, number];
};

const mapCenter: [number, number] = [77.5946, 12.9716];

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

function coordinateForIndex(index: number): [number, number] {
  const angle = index * 1.9;
  const radius = 0.035 + index * 0.012;

  return [
    Number((mapCenter[0] + Math.cos(angle) * radius).toFixed(6)),
    Number((mapCenter[1] + Math.sin(angle) * radius).toFixed(6))
  ];
}

function normalizeZone(
  id: string,
  data: DocumentData,
  index: number
): ZoneMarker {
  return {
    id,
    zone_name: normalizeString(data.zone_name, "Unnamed zone"),
    severity: normalizeString(data.severity, "unknown"),
    priority_score: normalizeNumber(data.priority_score),
    assigned_resources: normalizeAssignedResources(data.assigned_resources),
    coordinates: coordinateForIndex(index)
  };
}

function severityColor(severity: string): string {
  switch (severity.toLowerCase()) {
    case "critical":
    case "high":
      return "#dc2626";
    case "medium":
      return "#f97316";
    case "low":
      return "#16a34a";
    default:
      return "#52525b";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatResourceName(value: string): string {
  return value.replaceAll("_", " ");
}

function formatResources(resources: Record<string, number>): string {
  const entries = Object.entries(resources);

  if (entries.length === 0) {
    return "Pending";
  }

  return entries
    .map(
      ([resourceName, quantity]) =>
        `${escapeHtml(formatResourceName(resourceName))}: ${quantity}`
    )
    .join(", ");
}

function createMarkerElement(color: string): HTMLDivElement {
  const marker = document.createElement("div");
  marker.style.width = "18px";
  marker.style.height = "18px";
  marker.style.borderRadius = "999px";
  marker.style.background = color;
  marker.style.border = "3px solid #ffffff";
  marker.style.boxShadow = "0 6px 18px rgba(15, 23, 42, 0.28)";

  return marker;
}

function popupHTML(zone: ZoneMarker): string {
  return `
    <div style="min-width: 190px;">
      <p style="margin: 0 0 6px; font-weight: 700; color: #18181b;">
        ${escapeHtml(zone.zone_name)}
      </p>
      <p style="margin: 0 0 4px; color: #3f3f46;">
        Priority: ${zone.priority_score ?? "pending"}
      </p>
      <p style="margin: 0; color: #3f3f46;">
        Resources: ${formatResources(zone.assigned_resources)}
      </p>
    </div>
  `;
}

export function IncidentMap({ incidentId }: IncidentMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const [zones, setZones] = useState<ZoneMarker[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(incidentId));
  const [error, setError] = useState("");
  const accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

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
        const orderedDocs = [...snapshot.docs].sort((left, right) =>
          left.id.localeCompare(right.id)
        );
        const nextZones = orderedDocs.map((zoneSnapshot, index) =>
          normalizeZone(zoneSnapshot.id, zoneSnapshot.data(), index)
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

  useEffect(() => {
    if (!containerRef.current || mapRef.current || !accessToken) {
      return;
    }

    mapboxgl.accessToken = accessToken;

    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: mapCenter,
      zoom: 11
    });

    mapRef.current.addControl(new mapboxgl.NavigationControl(), "top-right");

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [accessToken]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current.clear();

    zones.forEach((zone) => {
      const marker = new mapboxgl.Marker({
        element: createMarkerElement(severityColor(zone.severity))
      })
        .setLngLat(zone.coordinates)
        .setPopup(new mapboxgl.Popup({ offset: 18 }).setHTML(popupHTML(zone)))
        .addTo(map);

      markersRef.current.set(zone.id, marker);
    });

    if (zones.length > 0) {
      const bounds = new mapboxgl.LngLatBounds();
      zones.forEach((zone) => bounds.extend(zone.coordinates));
      map.fitBounds(bounds as LngLatBoundsLike, {
        padding: 80,
        maxZoom: 13,
        duration: 600
      });
    }
  }, [zones]);

  const statusText = useMemo(() => {
    if (!accessToken) {
      return "Mapbox token missing";
    }

    if (isLoading) {
      return "Listening...";
    }

    return `${zones.length} markers`;
  }, [accessToken, isLoading, zones.length]);

  return (
    <section className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold text-zinc-950">Zone map</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Realtime severity and allocation view
          </p>
        </div>
        <span className="w-fit rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-sm font-medium text-zinc-700">
          {statusText}
        </span>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {!accessToken && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Add NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN to enable the map.
        </p>
      )}

      <div
        ref={containerRef}
        className="mt-4 h-[420px] overflow-hidden rounded-md border border-zinc-200 bg-zinc-100"
      />
    </section>
  );
}
