// Carry-forward: nothing that vanishes upstream is silently dropped. A provider in the previous release that is absent now is kept
// with tier unsupported / unsupported_reason withdrawn; a model absent now
// from a surviving provider is kept with status retired.
import type { Catalog } from "./schema.js";
import type { WorkingProvider } from "./overrides.js";

export type CarryReport = {
  providers_withdrawn: string[];
  models_retired: { provider: string; model: string }[];
};

export function carryForward(providers: WorkingProvider[], previous: Catalog | null): { providers: WorkingProvider[]; report: CarryReport } {
  const report: CarryReport = { providers_withdrawn: [], models_retired: [] };
  if (!previous) return { providers, report };
  const byId = new Map(providers.map((p) => [p.id, p]));
  for (const prev of previous.providers) {
    const cur = byId.get(prev.id);
    if (!cur) {
      const { resize_limits: _r, ...rest } = prev;
      void _r;
      const row: WorkingProvider = {
        ...rest,
        npm: "",
        api_is_template: false,
        tier: "unsupported",
        unsupported_reason: "withdrawn",
        models: prev.models.map((m) => ({ ...m, status: "retired" as const })),
      };
      providers.push(row);
      byId.set(row.id, row);
      report.providers_withdrawn.push(prev.id);
      continue;
    }
    const have = new Set(cur.models.map((m) => m.id));
    for (const pm of prev.models) {
      if (have.has(pm.id)) continue;
      cur.models.push({ ...pm, status: "retired" });
      report.models_retired.push({ provider: prev.id, model: pm.id });
    }
  }
  return { providers, report };
}
