"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, type DocumentData } from "firebase/firestore";
import L, { type DivIcon, type LatLngBoundsExpression } from "leaflet";
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Tooltip,
  useMap
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-defaulticon-compatibility/dist/leaflet-defaulticon-compatibility.css";
import "leaflet-defaulticon-compatibility";
import { db } from "@/lib/firebase";

type MapProps = {
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

const defaultCenter: [number, number] = [20.5937, 78.9629];

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
      .filter(([resourceName, quantity]) => resourceName.trim() && quantity > 0)
  );
}

function coordinateForIndex(index: number): [number, number] {
  const angle = index * 1.8;
  const radius = 1.6 + index * 0.18;

  return [
    Number((defaultCenter[0] + Math.sin(angle) * radius).toFixed(6)),
    Number((defaultCenter[1] + Math.cos(angle) * radius).toFixed(6))
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

function createSeverityIcon(severity: string): DivIcon {
  const color = severityColor(severity);

  return L.divIcon({
    className: "zone-severity-marker",
    html: `<span style="
      display: block;
      width: 18px;
      height: 18px;
      border-radius: 999px;
      background: ${color};
      border: 3px solid #ffffff;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.28);
    "></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12]
  });
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
    .map(([resourceName, quantity]) => `${formatResourceName(resourceName)}: ${quantity}`)
    .join(", ");
}

function FitToZones({ zones }: { zones: ZoneMarker[] }) {
  const map = useMap();

  useEffect(() => {
    if (zones.length === 0) {
      map.setView(defaultCenter, 5);
      return;
    }

    const bounds = zones.map((zone) => zone.coordinates) as LatLngBoundsExpression;
    map.fitBounds(bounds, {
      padding: [44, 44],
      maxZoom: 8
    });
  }, [map, zones]);

  return null;
}

export default function Map({ incidentId }: MapProps) {
  const [zones, setZones] = useState<ZoneMarker[]>([]);
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

  const statusText = useMemo(() => {
    if (isLoading) {
      return "Listening...";
    }

    return `${zones.length} markers`;
  }, [isLoading, zones.length]);

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

      <div className="mt-4 h-[460px] w-full overflow-hidden rounded-md border border-zinc-200 bg-zinc-100">
        <MapContainer
          center={defaultCenter}
          zoom={5}
          scrollWheelZoom
          className="h-full w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitToZones zones={zones} />

          {zones.map((zone) => (
            <Marker
              key={zone.id}
              position={zone.coordinates}
              icon={createSeverityIcon(zone.severity)}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                <span className="font-semibold">{zone.zone_name}</span>
                <br />
                <span className="text-xs uppercase opacity-75">{zone.severity}</span>
                {zone.priority_score && (
                  <span className="ml-1 text-xs font-bold">({zone.priority_score})</span>
                )}
              </Tooltip>
              <Popup>
                <div className="min-w-48">
                  <p className="m-0 text-sm font-semibold text-zinc-950">
                    {zone.zone_name}
                  </p>
                  <p className="mb-0 mt-2 text-sm text-zinc-700">
                    Priority: {zone.priority_score ?? "pending"}
                  </p>
                  <p className="mb-0 mt-1 text-sm text-zinc-700">
                    Resources: {formatResources(zone.assigned_resources)}
                  </p>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </section>
  );
}
