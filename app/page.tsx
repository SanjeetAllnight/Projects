"use client";

import dynamic from "next/dynamic";
import { FormEvent, useMemo, useState } from "react";
import { createIncident } from "@/lib/firebase";
import { ZoneList } from "@/components/ZoneList";

const Map = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => (
    <section className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="h-[460px] w-full rounded-md border border-zinc-200 bg-zinc-100" />
    </section>
  )
});

type StageKey = "incident" | "ingest" | "reason" | "dispatch";
type StageStatus = "idle" | "active" | "done" | "error";

type DispatchZone = {
  id: string;
  zone_name?: string;
  severity?: string;
  needs?: string[];
  confidence?: number;
  priority_score?: number;
  assigned_resources?: Record<string, number>;
  conflicts_detected?: string[];
  conflict_resolution?: string;
  dispatch_brief?: string;
};

type DispatchResponse = {
  incident_id: string;
  zones: DispatchZone[];
};

const initialStages: Record<StageKey, StageStatus> = {
  incident: "idle",
  ingest: "idle",
  reason: "idle",
  dispatch: "idle"
};

const stages: Array<{ key: StageKey; label: string }> = [
  { key: "incident", label: "Create incident" },
  { key: "ingest", label: "Extract zones" },
  { key: "reason", label: "Reason allocation" },
  { key: "dispatch", label: "Generate briefs" }
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResource(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.floor(parsed));
}

async function callPipelineStage<T>(
  path: string,
  incidentId: string,
  rawReports?: string
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      incident_id: incidentId,
      ...(rawReports ? { raw_reports: rawReports } : {})
    })
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `${path} failed.`;

    throw new Error(message);
  }

  return payload as T;
}

function statusClasses(status: StageStatus) {
  switch (status) {
    case "active":
      return "border-amber-300 bg-amber-50 text-amber-800";
    case "done":
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    case "error":
      return "border-red-300 bg-red-50 text-red-800";
    default:
      return "border-zinc-200 bg-white text-zinc-500";
  }
}

function statusLabel(status: StageStatus) {
  switch (status) {
    case "active":
      return "Running";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return "Waiting";
  }
}

export default function HomePage() {
  const [rawReports, setRawReports] = useState("");
  const [ambulances, setAmbulances] = useState("4");
  const [rescueTeams, setRescueTeams] = useState("6");
  const [helicopters, setHelicopters] = useState("1");
  const [stageStatus, setStageStatus] =
    useState<Record<StageKey, StageStatus>>(initialStages);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [incidentId, setIncidentId] = useState("");
  const [result, setResult] = useState<DispatchResponse | null>(null);
  const [error, setError] = useState("");

  const resourceInventory = useMemo(
    () => ({
      ambulances: parseResource(ambulances),
      rescue_teams: parseResource(rescueTeams),
      helicopters: parseResource(helicopters)
    }),
    [ambulances, rescueTeams, helicopters]
  );

  function setStage(key: StageKey, status: StageStatus) {
    setStageStatus((current) => ({
      ...current,
      [key]: status
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!rawReports.trim()) {
      setError("Enter disaster reports before starting the pipeline.");
      return;
    }

    setIsSubmitting(true);
    setIncidentId("");
    setResult(null);
    setError("");
    setStageStatus(initialStages);

    let activeStage: StageKey = "incident";

    try {
      setStage("incident", "active");
      const createdIncidentId = await createIncident({
        raw_reports: rawReports.trim(),
        resource_inventory: resourceInventory,
        status: "created"
      });
      setIncidentId(createdIncidentId);
      setStage("incident", "done");

      activeStage = "ingest";
      setStage("ingest", "active");
      await callPipelineStage("/api/ingest", createdIncidentId, rawReports);
      setStage("ingest", "done");

      activeStage = "reason";
      setStage("reason", "active");
      await callPipelineStage("/api/reason", createdIncidentId);
      setStage("reason", "done");

      activeStage = "dispatch";
      setStage("dispatch", "active");
      const dispatchResult = await callPipelineStage<DispatchResponse>(
        "/api/dispatch",
        createdIncidentId
      );
      setResult(dispatchResult);
      setStage("dispatch", "done");
    } catch (pipelineError) {
      setStage(activeStage, "error");
      setError(
        pipelineError instanceof Error
          ? pipelineError.message
          : "Pipeline failed."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <section className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-6 sm:px-8">
          <p className="text-sm font-medium uppercase text-teal-700">
            Disaster intelligence pipeline
          </p>
          <h1 className="max-w-4xl text-3xl font-semibold text-zinc-950 sm:text-4xl">
            AI Micro-Zone Disaster Intelligence & Resource Dispatcher
          </h1>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_390px]">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-5 rounded-md border border-zinc-200 bg-white p-5 shadow-sm"
        >
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-zinc-800">
              Disaster reports
            </span>
            <textarea
              value={rawReports}
              onChange={(event) => setRawReports(event.target.value)}
              disabled={isSubmitting}
              rows={13}
              className="min-h-72 resize-y rounded-md border border-zinc-300 bg-white px-3 py-3 text-sm leading-6 text-zinc-950 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-zinc-100"
              placeholder="Paste field reports, caller notes, social media updates, or responder observations..."
            />
          </label>

          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-800">
                Ambulances
              </span>
              <input
                type="number"
                min="0"
                value={ambulances}
                onChange={(event) => setAmbulances(event.target.value)}
                disabled={isSubmitting}
                className="h-11 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-zinc-100"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-800">
                Rescue teams
              </span>
              <input
                type="number"
                min="0"
                value={rescueTeams}
                onChange={(event) => setRescueTeams(event.target.value)}
                disabled={isSubmitting}
                className="h-11 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-zinc-100"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-800">
                Helicopters
              </span>
              <input
                type="number"
                min="0"
                value={helicopters}
                onChange={(event) => setHelicopters(event.target.value)}
                disabled={isSubmitting}
                className="h-11 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-zinc-100"
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="h-11 w-full rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-200 disabled:cursor-not-allowed disabled:bg-zinc-400 sm:w-fit"
          >
            {isSubmitting ? "Running pipeline..." : "Submit incident"}
          </button>
        </form>

        <aside className="flex flex-col gap-5">
          <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-zinc-950">
              Pipeline status
            </h2>
            <div className="mt-4 flex flex-col gap-3">
              {stages.map((stage) => (
                <div
                  key={stage.key}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${statusClasses(
                    stageStatus[stage.key]
                  )}`}
                >
                  <span className="font-medium">{stage.label}</span>
                  <span>{statusLabel(stageStatus[stage.key])}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-zinc-950">
              Resource inventory
            </h2>
            <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-zinc-500">Ambulances</dt>
                <dd className="mt-1 font-semibold text-zinc-950">
                  {resourceInventory.ambulances}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Teams</dt>
                <dd className="mt-1 font-semibold text-zinc-950">
                  {resourceInventory.rescue_teams}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Aircraft</dt>
                <dd className="mt-1 font-semibold text-zinc-950">
                  {resourceInventory.helicopters}
                </dd>
              </div>
            </dl>
          </div>

          {(incidentId || error) && (
            <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
              {incidentId && (
                <>
                  <h2 className="text-base font-semibold text-zinc-950">
                    Incident
                  </h2>
                  <p className="mt-2 break-all text-sm text-zinc-600">
                    {incidentId}
                  </p>
                </>
              )}
              {error && (
                <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {error}
                </p>
              )}
            </div>
          )}
        </aside>
      </section>

      {incidentId && (
        <section className="mx-auto flex max-w-7xl flex-col gap-6 px-5 pb-10 sm:px-8">
          <Map incidentId={incidentId} />
          <ZoneList incidentId={incidentId} />

          {result && (
            <pre className="mt-5 overflow-auto rounded-md border border-zinc-200 bg-zinc-950 p-4 text-xs leading-5 text-zinc-100">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </section>
      )}
    </main>
  );
}
