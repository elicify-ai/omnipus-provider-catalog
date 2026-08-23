// The merge: models.dev is primary; LiteLLM cross-checks context_window,
// max_output_tokens, tool_call and input modalities with the disagreement rule
// from ADR-067 §2 / spec US-2.AC2 / F-04:
//   - numeric fields within 5 % or 4,096 tokens (whichever is larger) are not
//     disputes: publish the LOWER value, record both;
//   - a larger delta, or any boolean/modality difference, is a dispute: publish
//     the last-known-good value from the previous release (models.dev's when
//     there is none), mark the model `disputed: true`, record it so the
//     publish phase can open ONE issue;
//   - a value models.dev lacks (0 = unknown) that LiteLLM carries is filled
//     from LiteLLM and recorded as a fill, never as a dispute.
import type { Catalog, Modality, Model, Provider } from "./schema.js";
import { MODALITIES } from "./schema.js";
import type { LiteLLMFacts, NormalisedModel, NormalisedProvider } from "./sources.js";
import { lookupLiteLLM } from "./sources.js";

export const TOLERANCE_ABS = 4096;
export const TOLERANCE_REL = 0.05;

export type NumericField = "context_window" | "max_output_tokens";

export type Comparison =
  | { kind: "agree" }
  | { kind: "within_tolerance"; published: number; models_dev: number; litellm: number }
  | { kind: "dispute"; models_dev: number; litellm: number };

/** The numeric disagreement rule. Both inputs are positive (0 = unknown is handled by the caller). */
export function compareNumeric(modelsDev: number, litellm: number): Comparison {
  if (modelsDev === litellm) return { kind: "agree" };
  const delta = Math.abs(modelsDev - litellm);
  const tolerance = Math.max(TOLERANCE_ABS, TOLERANCE_REL * Math.max(modelsDev, litellm));
  if (delta <= tolerance) {
    return { kind: "within_tolerance", published: Math.min(modelsDev, litellm), models_dev: modelsDev, litellm };
  }
  return { kind: "dispute", models_dev: modelsDev, litellm };
}

export type DisputeRecord = {
  provider: string;
  model: string;
  field: NumericField | "tool_call" | `input_modalities.${Exclude<Modality, "text">}`;
  models_dev: number | boolean;
  litellm: number | boolean;
  litellm_key: string;
  published: number | boolean;
  /** true when `published` came from the previous release; false when it is models.dev's value. */
  last_known_good: boolean;
};
export type ToleranceRecord = {
  provider: string;
  model: string;
  field: NumericField;
  models_dev: number;
  litellm: number;
  published: number;
};
export type FillRecord = { provider: string; model: string; field: NumericField; litellm: number };
/** A model neither registry knows a context window for; it is not published (publication rule: every active model has a real window). */
export type NoWindowRecord = { provider: string; model: string; litellm_key: string | null };

export type MergeReport = {
  cross_checked: number;
  disputes: DisputeRecord[];
  within_tolerance: ToleranceRecord[];
  filled_from_litellm: FillRecord[];
  skipped_no_window: NoWindowRecord[];
};

export type MergedModel = Model;
export type MergedProvider = Omit<Provider, "company" | "tier" | "auth_methods" | "aliases" | "locality" | "resize_limits"> & {
  /** Provider-level facts the merge knows; finalisation fills the rest. */
  api_is_template: boolean;
  npm: string;
};

function previousModel(previous: Catalog | null, providerId: string, modelId: string): Model | undefined {
  return previous?.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
}

function sortedModalities(mods: Iterable<Modality>): Modality[] {
  const set = new Set(mods);
  return MODALITIES.filter((m) => set.has(m));
}

/** Cross-check one models.dev model against LiteLLM's facts. Pure; returns the published model plus records. */
export function mergeModel(
  providerId: string,
  md: NormalisedModel,
  ll: LiteLLMFacts | undefined,
  previous: Model | undefined,
): { model: Model; disputes: DisputeRecord[]; tolerance: ToleranceRecord[]; fills: FillRecord[] } {
  const model: Model = {
    id: md.id,
    name: md.name,
    ...(md.release_date ? { release_date: md.release_date } : {}),
    tool_call: md.tool_call,
    context_window: md.context_window,
    max_output_tokens: md.max_output_tokens,
    input_modalities: sortedModalities(md.input_modalities),
    status: "active",
  };
  const disputes: DisputeRecord[] = [];
  const tolerance: ToleranceRecord[] = [];
  const fills: FillRecord[] = [];
  if (!ll) return { model, disputes, tolerance, fills };

  for (const field of ["context_window", "max_output_tokens"] as const) {
    const a = md[field];
    const b = ll[field];
    if (b === undefined) continue;
    if (a === 0) {
      model[field] = b;
      fills.push({ provider: providerId, model: md.id, field, litellm: b });
      continue;
    }
    const c = compareNumeric(a, b);
    if (c.kind === "within_tolerance") {
      model[field] = c.published;
      tolerance.push({ provider: providerId, model: md.id, field, models_dev: a, litellm: b, published: c.published });
    } else if (c.kind === "dispute") {
      const lkg = previous?.[field];
      const useLkg = typeof lkg === "number" && lkg > 0;
      model[field] = useLkg ? lkg : a;
      disputes.push({
        provider: providerId,
        model: md.id,
        field,
        models_dev: a,
        litellm: b,
        litellm_key: ll.key,
        published: model[field],
        last_known_good: useLkg,
      });
    }
  }

  if (ll.tool_call !== undefined && ll.tool_call !== md.tool_call) {
    const useLkg = previous !== undefined;
    model.tool_call = useLkg ? previous.tool_call : md.tool_call;
    disputes.push({
      provider: providerId,
      model: md.id,
      field: "tool_call",
      models_dev: md.tool_call,
      litellm: ll.tool_call,
      litellm_key: ll.key,
      published: model.tool_call,
      last_known_good: useLkg,
    });
  }

  if (ll.modalities) {
    const mods = new Set<Modality>(model.input_modalities);
    for (const m of ["image", "audio", "video", "pdf"] as const) {
      const stated = ll.modalities[m];
      if (stated === undefined) continue;
      const has = md.input_modalities.includes(m);
      if (stated === has) continue;
      const useLkg = previous !== undefined;
      const published = useLkg ? previous.input_modalities.includes(m) : has;
      if (published) mods.add(m);
      else mods.delete(m);
      disputes.push({
        provider: providerId,
        model: md.id,
        field: `input_modalities.${m}`,
        models_dev: has,
        litellm: stated,
        litellm_key: ll.key,
        published,
        last_known_good: useLkg,
      });
    }
    model.input_modalities = sortedModalities(mods);
  }

  if (disputes.length > 0) model.disputed = true;
  return { model, disputes, tolerance, fills };
}

export function mergeRegistries(
  modelsDev: NormalisedProvider[],
  litellm: Map<string, LiteLLMFacts>,
  previous: Catalog | null,
): { providers: MergedProvider[]; report: MergeReport } {
  const report: MergeReport = { cross_checked: 0, disputes: [], within_tolerance: [], filled_from_litellm: [], skipped_no_window: [] };
  const providers: MergedProvider[] = [];
  for (const p of modelsDev) {
    const models: Model[] = [];
    for (const md of p.models) {
      const ll = lookupLiteLLM(litellm, p.id, md.id);
      if (ll) report.cross_checked++;
      const r = mergeModel(p.id, md, ll, previousModel(previous, p.id, md.id));
      if (r.model.context_window <= 0) {
        // Unknown in models.dev and not filled by LiteLLM: the consumer would
        // treat 0 as "unknown" (spec US-1.AC5), but the publication rule is that
        // every active row carries a real window, so the row is held back —
        // recorded here, never silently — until a registry learns the limit.
        report.skipped_no_window.push({ provider: p.id, model: md.id, litellm_key: ll?.key ?? null });
        continue;
      }
      models.push(r.model);
      report.disputes.push(...r.disputes);
      report.within_tolerance.push(...r.tolerance);
      report.filled_from_litellm.push(...r.fills);
    }
    providers.push({
      id: p.id,
      name: p.name,
      api: p.api,
      api_is_template: p.api_is_template,
      npm: p.npm,
      protocol: p.protocol,
      env: p.env,
      models,
    });
  }
  return { providers, report };
}
