import { describe, expect, it } from "vitest";

import { carryForward } from "../src/carry.js";
import { foldInferenceProfiles } from "../src/inference-profiles.js";
import type { WorkingProvider } from "../src/overrides.js";
import type { Catalog, Provider } from "../src/schema.js";

const prevProvider = (id: string, modelIds: string[]): Provider => ({
  id,
  name: id,
  company: id,
  api: `https://api.${id}.example/v1`,
  protocol: "openai-compatible",
  env: [],
  tier: "standard",
  auth_methods: ["api_key"],
  aliases: [],
  resize_limits: { long_edge_px: 1, max_bytes: 1 },
  models: modelIds.map((m) => ({ id: m, name: m, tool_call: true, context_window: 1000, max_output_tokens: 100, input_modalities: ["text"], status: "active" as const })),
});

const previous: Catalog = {
  schema_version: "2.0.0",
  version: "v2026.8.1",
  updated_at: "2026-08-01T00:00:00Z",
  generated_at: "2026-08-01T00:00:00Z",
  source: "x",
  sources: {
    models_dev: { name: "models.dev", url: "u", license: "MIT", fetched_at: "t", commit: null, etag: null, sha256: "0".repeat(64), bytes: 1 },
    litellm: { name: "litellm", url: "u", license: "MIT", fetched_at: "t", commit: null, etag: null, sha256: "0".repeat(64), bytes: 1 },
    overrides_commit: null,
    previous_version: null,
  },
  default_resize_limits: { long_edge_px: 1, max_bytes: 1 },
  providers: [prevProvider("alpha", ["a1", "a2"]), prevProvider("gone", ["g1"])],
};

const working = (id: string, modelIds: string[]): WorkingProvider => ({
  id,
  name: id,
  npm: "@ai-sdk/openai-compatible",
  api: `https://api.${id}.example/v1`,
  api_is_template: false,
  protocol: "openai-compatible",
  env: [],
  models: modelIds.map((m) => ({ id: m, name: m, tool_call: true, context_window: 2000, max_output_tokens: 200, input_modalities: ["text"], status: "active" as const })),
});

describe("carry-forward (nothing vanishes silently)", () => {
  it("a model that vanished from a surviving provider is kept as status retired with its last published values", () => {
    const { providers, report } = carryForward([working("alpha", ["a1"])], previous);
    const alpha = providers.find((p) => p.id === "alpha")!;
    expect(alpha.models.map((m) => [m.id, m.status])).toEqual([
      ["a1", "active"],
      ["a2", "retired"],
    ]);
    expect(alpha.models[1]!.context_window).toBe(1000); // previous release's number, not re-derived
    expect(report.models_retired).toEqual([{ provider: "alpha", model: "a2" }]);
  });

  it("a provider that vanished is kept as tier unsupported / withdrawn with all models retired", () => {
    const { providers, report } = carryForward([working("alpha", ["a1", "a2"])], previous);
    const gone = providers.find((p) => p.id === "gone")!;
    expect(gone.tier).toBe("unsupported");
    expect(gone.unsupported_reason).toBe("withdrawn");
    expect(gone.models.every((m) => m.status === "retired")).toBe(true);
    expect(report.providers_withdrawn).toEqual(["gone"]);
  });

  it("a model that comes back upstream is active again", () => {
    const { providers } = carryForward([working("alpha", ["a1", "a2"]), working("gone", ["g1"])], previous);
    expect(providers.every((p) => p.models.every((m) => m.status === "active"))).toBe(true);
    expect(providers.find((p) => p.id === "gone")!.tier).toBeUndefined();
  });

  it("no previous release → nothing to carry", () => {
    const { providers, report } = carryForward([working("alpha", ["a1"])], null);
    expect(providers).toHaveLength(1);
    expect(report).toEqual({ providers_withdrawn: [], models_retired: [] });
  });

  // Transition-day regression: the previous release published amazon-bedrock's
  // region-prefixed inference-profile variants as literal, separate model ids
  // (the fold did not exist yet). Once the fold ships, today's merged list only
  // has the folded base id — if carryForward compared against the RAW previous
  // release, every prefixed variant would look "vanished" and be carried
  // forward as a phantom status: retired row, even though the model is still
  // very much offered upstream (bedrock-region/CONTRACT.md). The fix is to
  // fold the previous release's amazon-bedrock models the same way before
  // carryForward ever sees them (src/assemble.ts).
  it("folding the previous release's amazon-bedrock models before carry-forward avoids phantom retired rows for prefixed variants that were only ever renamed, not dropped", () => {
    const rawPreviousBedrock = prevProvider("amazon-bedrock", ["anthropic.claude-sonnet-4-6", "eu.anthropic.claude-sonnet-4-6", "apac.anthropic.claude-sonnet-4-6"]);
    const previousWithBedrock: Catalog = { ...previous, providers: [...previous.providers, rawPreviousBedrock] };
    const currentFolded = working("amazon-bedrock", ["anthropic.claude-sonnet-4-6"]); // fold already collapsed the three raw ids into one base id

    // Without folding the previous side first: the two prefixed ids look vanished.
    const naive = carryForward([currentFolded], previousWithBedrock);
    const naiveBedrock = naive.providers.find((p) => p.id === "amazon-bedrock")!;
    expect(naiveBedrock.models.filter((m) => m.status === "retired").map((m) => m.id).sort()).toEqual(["apac.anthropic.claude-sonnet-4-6", "eu.anthropic.claude-sonnet-4-6"]);

    // Folding the previous release's amazon-bedrock models first (the actual fix): no phantom retirements.
    const previousFolded: Catalog = {
      ...previousWithBedrock,
      providers: previousWithBedrock.providers.map((p) => (p.id === "amazon-bedrock" ? { ...p, models: foldInferenceProfiles(p.models) } : p)),
    };
    const fixed = carryForward([working("amazon-bedrock", ["anthropic.claude-sonnet-4-6"])], previousFolded);
    const fixedBedrock = fixed.providers.find((p) => p.id === "amazon-bedrock")!;
    expect(fixedBedrock.models.every((m) => m.status === "active")).toBe(true);
    expect(fixed.report.models_retired.filter((r) => r.provider === "amazon-bedrock")).toEqual([]);
  });
});
