// overrides/ — hand-maintained data that wins over both registries, applied
// LAST. Three YAML files, every row keyed by id and carrying a `reason`:
//   overrides/providers.yaml        provider-level fields keyed by provider id
//   overrides/models.yaml           model-level fields keyed by provider id → model id
//   overrides/local-providers.yaml  full rows for providers absent from models.dev
// The format is documented in overrides/README.md.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Catalog, Model, Protocol } from "./schema.js";
import { AUTH_METHODS, CLI_KINDS, MODALITIES, MODEL_STATUSES, PROTOCOLS, ProtocolEntry, TIERS, UNSUPPORTED_REASONS } from "./schema.js";
import type { MergedProvider } from "./merge.js";
import type { DisputeRecord } from "./merge.js";

const Reason = z.string().min(1, "every override row needs a reason (issue number, docs link, or dated probe)");

export const ProviderOverride = z
  .object({
    reason: Reason,
    name: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    api: z.string().optional(),
    protocol: z.enum(PROTOCOLS).optional(),
    protocols: z.array(ProtocolEntry).optional(),
    env: z.array(z.string()).optional(),
    region: z.string().optional(),
    plan: z.string().optional(),
    tier: z.enum(TIERS).optional(),
    unsupported_reason: z.enum(UNSUPPORTED_REASONS).optional(),
    auth_methods: z.array(z.enum(AUTH_METHODS)).min(1).optional(),
    aliases: z.array(z.string()).optional(),
    cli_kind: z.enum(CLI_KINDS).optional(),
    token_source: z.string().optional(),
  })
  .strict();
export type ProviderOverride = z.infer<typeof ProviderOverride>;

export const ModelOverride = z
  .object({
    reason: Reason,
    name: z.string().min(1).optional(),
    release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tool_call: z.boolean().optional(),
    context_window: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    input_modalities: z.array(z.enum(MODALITIES)).min(1).optional(),
    status: z.enum(MODEL_STATUSES).optional(),
  })
  .strict();
export type ModelOverride = z.infer<typeof ModelOverride>;

const LocalModel = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tool_call: z.boolean(),
    context_window: z.number().int().nonnegative(),
    max_output_tokens: z.number().int().nonnegative(),
    input_modalities: z.array(z.enum(MODALITIES)).min(1),
  })
  .strict();

export const LocalProvider = z
  .object({
    reason: Reason,
    name: z.string().min(1),
    company: z.string().min(1).optional(),
    api: z.string(),
    protocol: z.enum(PROTOCOLS),
    protocols: z.array(ProtocolEntry).optional(),
    env: z.array(z.string()).default([]),
    region: z.string().optional(),
    plan: z.string().optional(),
    tier: z.enum(TIERS).optional(),
    unsupported_reason: z.enum(UNSUPPORTED_REASONS).optional(),
    auth_methods: z.array(z.enum(AUTH_METHODS)).min(1).optional(),
    aliases: z.array(z.string()).optional(),
    cli_kind: z.enum(CLI_KINDS).optional(),
    token_source: z.string().optional(),
    /** Copy the model list of this models.dev provider (same route family, e.g. codex-cli ← openai). */
    models_from: z.string().min(1).optional(),
    /** With models_from: keep only these ids (or ids matching these regexes when prefixed with `re:`). */
    model_ids: z.array(z.string().min(1)).optional(),
    /** Explicit models (appended after models_from). */
    models: z.array(LocalModel).optional(),
  })
  .strict();
export type LocalProvider = z.infer<typeof LocalProvider>;

export const ProvidersFile = z.object({ providers: z.record(ProviderOverride).default({}) }).strict();
export const ModelsFile = z.object({ models: z.record(z.record(ModelOverride)).default({}) }).strict();
export const LocalProvidersFile = z.object({ providers: z.record(LocalProvider).default({}) }).strict();

export type Overrides = {
  providers: Record<string, ProviderOverride>;
  models: Record<string, Record<string, ModelOverride>>;
  local: Record<string, LocalProvider>;
};

async function readYaml(file: string): Promise<unknown> {
  try {
    return parseYaml(await readFile(file, "utf8")) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function loadOverrides(dir: string): Promise<Overrides> {
  const providers = ProvidersFile.parse(await readYaml(path.join(dir, "providers.yaml")));
  const models = ModelsFile.parse(await readYaml(path.join(dir, "models.yaml")));
  const local = LocalProvidersFile.parse(await readYaml(path.join(dir, "local-providers.yaml")));
  return { providers: providers.providers, models: models.models, local: local.providers };
}

/** A provider row after the registry merge and before finalisation; overrides may touch every field. */
export type WorkingProvider = MergedProvider & {
  company?: string;
  region?: string;
  plan?: string;
  tier?: (typeof TIERS)[number];
  unsupported_reason?: (typeof UNSUPPORTED_REASONS)[number];
  auth_methods?: (typeof AUTH_METHODS)[number][];
  aliases?: string[];
  cli_kind?: (typeof CLI_KINDS)[number];
  token_source?: string;
  protocols?: { protocol: Protocol; api: string }[];
  /** true when the row was created (not just edited) by overrides/local-providers.yaml */
  from_local_file?: boolean;
};

export type OverrideReport = {
  providers_applied: string[];
  models_applied: { provider: string; model: string }[];
  models_created: { provider: string; model: string }[];
  local_rows_created: string[];
  local_rows_merged: string[];
  disputes_resolved_by_override: DisputeRecord[];
};

function matchId(id: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.startsWith("re:") ? new RegExp(p.slice(3)).test(id) : p === id));
}

/**
 * Apply overrides/ onto the working providers. Local-provider rows are added
 * (or merged over an existing registry row of the same id); then provider
 * overrides; then model overrides. A model override on a field that was
 * disputed resolves that dispute (override-sourced values never raise one).
 */
export function applyOverrides(
  providers: WorkingProvider[],
  overrides: Overrides,
  disputes: DisputeRecord[],
  registry: MergedProvider[],
): { providers: WorkingProvider[]; disputes: DisputeRecord[]; report: OverrideReport } {
  const byId = new Map<string, WorkingProvider>(providers.map((p) => [p.id, p]));
  const report: OverrideReport = {
    providers_applied: [],
    models_applied: [],
    models_created: [],
    local_rows_created: [],
    local_rows_merged: [],
    disputes_resolved_by_override: [],
  };

  // 1. local providers
  for (const [id, lp] of Object.entries(overrides.local)) {
    const { reason: _r, models_from, model_ids, models: explicit, ...fields } = lp;
    void _r;
    let models: Model[] = [];
    if (models_from) {
      const src = registry.find((p) => p.id === models_from);
      if (!src) throw new Error(`local provider ${id}: models_from ${JSON.stringify(models_from)} is not a models.dev provider`);
      models = src.models
        .filter((m) => !model_ids || matchId(m.id, model_ids))
        .map((m) => ({ ...m, input_modalities: [...m.input_modalities] }));
    }
    for (const m of explicit ?? []) {
      if (models.some((x) => x.id === m.id)) continue;
      models.push({ ...m, status: "active" });
    }
    const existing = byId.get(id);
    if (existing) {
      Object.assign(existing, fields);
      if (models.length > 0) existing.models = models;
      report.local_rows_merged.push(id);
    } else {
      const row: WorkingProvider = {
        id,
        npm: "",
        api_is_template: false,
        ...fields,
        models,
        from_local_file: true,
      };
      byId.set(id, row);
      report.local_rows_created.push(id);
    }
  }

  // 2. provider overrides
  for (const [id, ov] of Object.entries(overrides.providers)) {
    const row = byId.get(id);
    if (!row) throw new Error(`overrides/providers.yaml: ${JSON.stringify(id)} is not a provider in the merged document`);
    const { reason: _r, ...fields } = ov;
    void _r;
    Object.assign(row, fields);
    if (fields.api !== undefined) row.api_is_template = false;
    report.providers_applied.push(id);
  }

  // 3. model overrides
  let remaining = disputes;
  for (const [pid, models] of Object.entries(overrides.models)) {
    const row = byId.get(pid);
    if (!row) throw new Error(`overrides/models.yaml: ${JSON.stringify(pid)} is not a provider in the merged document`);
    for (const [mid, ov] of Object.entries(models)) {
      const { reason: _r, ...fields } = ov;
      void _r;
      let model = row.models.find((m) => m.id === mid);
      if (!model) {
        // A legacy model the registries retired: the override must be complete enough to stand alone.
        if (fields.context_window === undefined || fields.max_output_tokens === undefined || !fields.input_modalities || fields.tool_call === undefined) {
          throw new Error(`overrides/models.yaml: ${pid}/${mid} is not in the merged document; a new row needs context_window, max_output_tokens, input_modalities and tool_call`);
        }
        model = {
          id: mid,
          name: fields.name ?? mid,
          tool_call: fields.tool_call,
          context_window: fields.context_window,
          max_output_tokens: fields.max_output_tokens,
          input_modalities: fields.input_modalities,
          status: fields.status ?? "active",
        };
        row.models.push(model);
        report.models_created.push({ provider: pid, model: mid });
      }
      Object.assign(model, fields);
      report.models_applied.push({ provider: pid, model: mid });
      const overriddenFields = new Set(Object.keys(fields));
      const resolved = remaining.filter(
        (d) =>
          d.provider === pid &&
          d.model === mid &&
          (overriddenFields.has(d.field) || (d.field.startsWith("input_modalities.") && overriddenFields.has("input_modalities"))),
      );
      if (resolved.length > 0) {
        report.disputes_resolved_by_override.push(...resolved);
        remaining = remaining.filter((d) => !resolved.includes(d));
      }
      model.disputed = remaining.some((d) => d.provider === pid && d.model === mid) ? true : undefined;
      if (model.disputed === undefined) delete model.disputed;
    }
  }

  return { providers: [...byId.values()], disputes: remaining, report };
}

export function catalogProvider(previous: Catalog | null, id: string) {
  return previous?.providers.find((p) => p.id === id);
}
