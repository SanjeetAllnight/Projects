"use client";

type ResourceUsage = {
  total: number;
  allocated: number;
  remaining: number;
};

type GlobalSummaryProps = {
  summary: {
    strategy: string;
    resource_usage: Record<string, ResourceUsage>;
    unfulfilled_zones_count: number;
  };
};

function formatKey(key: string): string {
  return key.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function ResourceSummary({ summary }: GlobalSummaryProps) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-zinc-950">Resource Allocation Summary</h2>
      
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider">Strategy</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-700">
            {summary.strategy || "Prioritizing resources for critical zones based on life-threat severity and urgency."}
          </p>
          
          {summary.unfulfilled_zones_count > 0 && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              <span role="img" aria-label="warning">⚠️</span>
              {summary.unfulfilled_zones_count} zones still have unmet needs
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider">Resource Usage</h3>
          <div className="grid gap-3">
            {Object.entries(summary.resource_usage).map(([resource, usage]) => (
              <div key={resource} className="flex flex-col gap-1">
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-zinc-800">{formatKey(resource)}</span>
                  <span className="text-zinc-500">
                    {usage.total} total | {usage.allocated} allocated | {usage.remaining} remaining
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                  <div 
                    className="h-full bg-teal-600 transition-all duration-500" 
                    style={{ width: `${(usage.allocated / (usage.total || 1)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {Object.keys(summary.resource_usage).length === 0 && (
              <p className="text-sm text-zinc-500 italic">No usage data available.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
