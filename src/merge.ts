// The merge: models.dev is primary; LiteLLM cross-checks context_window,
// max_output_tokens, tool_call, input modalities and prices with the
// disagreement rule below:
//   - token counts within 5 % or 4,096 tokens (whichever is larger) are not
//     disputes: publish the LOWER value, record both;
//   - prices (USD per 1 million tokens) use 5 % of the larger price ONLY.
//     The 4,096 absolute tolerance is for token counts and is never applied
//     to dollars. Within 5 %: publish the lower price. Beyond 5 %: dispute;
//   - a larger delta, or any boolean/modality difference, is a dispute: publish
//     the last-known-good value from the previous release (models.dev's when
//     there is none), mark the model `disputed: true`, record it so the
//     publish phase can open ONE issue;
//   - a token count models.dev lacks (0 = unknown) that LiteLLM carries is
//     filled from LiteLLM and recorded as a fill, never as a dispute;
//   - a price models.dev lacks (the field is absent — 0 is a real price) that
//     LiteLLM carries is filled the same way. A model with no price in either
//     source is published without a cost object.
import type { Catalog, Modality, Model, ModelCost, Provider } from "./schema.js";
import { MODALITIES } from "./schema.js";
import type { LiteLLMFacts, NormalisedModel, NormalisedProvider } from "./sources.js";
import { lookupLiteLLM } from "./sources.js";

export const TOLERANCE_ABS = 4096;
export const TOLERANCE_REL = 0.05;

export type NumericField = "context_window" | "max_output_tokens";
export type PriceField = "input" | "output" | "reasoning" | "cache_read" | "cache_write" | "cache_write_1h";
export type CostField = `cost.${PriceField}`;

const PRICE_FIELDS: readonly PriceField[] = ["input", "output", "reasoning", "cache_read", "cache_write", "cache_write_1h"];

export type Comparison =
  | { kind: "agree" }
  | { kind: "within_tolerance"; published: number; models_dev: number; litellm: number }
  | { kind: "dispute"; models_dev: number; litellm: number };

/** Token-count disagreement. Both inputs are positive (0 = unknown is handled by the caller). */
export function compareNumeric(modelsDev: number, litellm: number): Comparison {
  if (modelsDev === litellm) return { kind: "agree" };
  const delta = Math.abs(modelsDev - litellm);
  const tolerance = Math.max(TOLERANCE_ABS, TOLERANCE_REL * Math.max(modelsDev, litellm));
  if (delta <= tolerance) {
    return { kind: "within_tolerance", published: Math.min(modelsDev, litellm), models_dev: modelsDev, litellm };
  }
  return { kind: "dispute", models_dev: modelsDev, litellm };
}

/**
 * Price disagreement, USD per 1 million tokens. 5 % of the larger price only.
 * A gap of a few cents on a $1 price is a dispute; 4,096 is not a dollar tolerance.
 * Compared in 1e-6 units so a decimal "exactly 5 %" is not tripped by binary
 * dust. Both inputs are finite and >= 0 (0 is a real price, not "unknown").
 */
export function comparePrice(modelsDev: number, litellm: number): Comparison {
  const a = Math.round(modelsDev * 1e6);
  const b = Math.round(litellm * 1e6);
  if (a === b) return { kind: "agree" };
  const delta = Math.abs(a - b);
  const tolerance = TOLERANCE_REL * Math.max(a, b);
  if (delta <= tolerance) {
    return { kind: "within_tolerance", published: Math.min(modelsDev, litellm), models_dev: modelsDev, litellm };
  }
  return { kind: "dispute", models_dev: modelsDev, litellm };
}

export type DisputeRecord = {
  provider: string;
  model: string;
  field: NumericField | CostField | "tool_call" | `input_modalities.${Exclude<Modality, "text">}`;
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
  field: NumericField | CostField;
  models_dev: number;
  litellm: number;
  published: number;
};
export type FillRecord = { provider: string; model: string; field: NumericField | CostField; litellm: number };
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

function previousPrice(previous: ModelCost | undefined, field: PriceField): number | undefined {
  const v = previous?.[field];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Cross-check prices. Tiers and `context_over_200k` are copied from models.dev
 * unchanged: LiteLLM's above-N fields are a different encoding, and rewriting
 * `tier.size` would flatten every source onto one boundary rule.
 * A LiteLLM cost with no input or no output cannot fill a missing models.dev
 * cost (both are required on a published cost object).
 */
function mergeCost(
  providerId: string,
  md: NormalisedModel,
  llCost: LiteLLMFacts["cost"] | undefined,
  litellmKey: string | undefined,
  previous: ModelCost | undefined,
): { cost?: ModelCost; disputes: DisputeRecord[]; tolerance: ToleranceRecord[]; fills: FillRecord[] } {
  const disputes: DisputeRecord[] = [];
  const tolerance: ToleranceRecord[] = [];
  const fills: FillRecord[] = [];

  if (!md.cost) {
    if (llCost?.input === undefined || llCost.output === undefined) return { disputes, tolerance, fills };
    const cost: ModelCost = { input: llCost.input, output: llCost.output };
    fills.push(
      { provider: providerId, model: md.id, field: "cost.input", litellm: llCost.input },
      { provider: providerId, model: md.id, field: "cost.output", litellm: llCost.output },
    );
    for (const field of ["reasoning", "cache_read", "cache_write", "cache_write_1h"] as const) {
      const v = llCost[field];
      if (v === undefined) continue;
      cost[field] = v;
      fills.push({ provider: providerId, model: md.id, field: `cost.${field}`, litellm: v });
    }
    return { cost, disputes, tolerance, fills };
  }

  const cost = structuredClone(md.cost);
  if (!llCost) return { cost, disputes, tolerance, fills };

  for (const field of PRICE_FIELDS) {
    const a = md.cost[field];
    const b = llCost[field];
    if (b === undefined) continue;
    if (a === undefined) {
      cost[field] = b;
      fills.push({ provider: providerId, model: md.id, field: `cost.${field}`, litellm: b });
      continue;
    }
    const compared = comparePrice(a, b);
    if (compared.kind === "agree") continue;
    if (compared.kind === "within_tolerance") {
      cost[field] = compared.published;
      tolerance.push({
        provider: providerId,
        model: md.id,
        field: `cost.${field}`,
        models_dev: a,
        litellm: b,
        published: compared.published,
      });
      continue;
    }
    const lkg = previousPrice(previous, field);
    const published = lkg !== undefined ? lkg : a;
    cost[field] = published;
    disputes.push({
      provider: providerId,
      model: md.id,
      field: `cost.${field}`,
      models_dev: a,
      litellm: b,
      litellm_key: litellmKey ?? "",
      published,
      last_known_good: lkg !== undefined,
    });
  }
  return { cost, disputes, tolerance, fills };
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
  const cost = mergeCost(providerId, md, ll?.cost, ll?.key, previous?.cost);
  if (cost.cost) model.cost = cost.cost;
  disputes.push(...cost.disputes);
  tolerance.push(...cost.tolerance);
  fills.push(...cost.fills);
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
        // treat 0 as "unknown", but the publication rule is that
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
