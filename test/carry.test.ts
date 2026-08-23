import { describe, expect, it } from "vitest";

import { carryForward } from "../src/carry.js";
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
});
