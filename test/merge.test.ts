import { describe, expect, it } from "vitest";

import { compareNumeric, mergeModel, mergeRegistries, TOLERANCE_ABS } from "../src/merge.js";
import type { Model } from "../src/schema.js";
import type { LiteLLMFacts, NormalisedModel, NormalisedProvider } from "../src/sources.js";
import { indexLiteLLM } from "../src/sources.js";

const md = (over: Partial<NormalisedModel> = {}): NormalisedModel => ({
  id: "m",
  name: "M",
  tool_call: true,
  context_window: 128000,
  max_output_tokens: 16384,
  input_modalities: ["text", "image"],
  ...over,
});

describe("disagreement tolerance (spec F-04: 5 % or 4,096 tokens, whichever is larger)", () => {
  it("equal values agree", () => {
    expect(compareNumeric(128000, 128000)).toEqual({ kind: "agree" });
  });
  it("a delta of exactly 4,096 tokens on a small window is within tolerance and publishes the lower value", () => {
    const r = compareNumeric(8192, 8192 + TOLERANCE_ABS);
    expect(r).toEqual({ kind: "within_tolerance", published: 8192, models_dev: 8192, litellm: 12288 });
  });
  it("a delta of 4,097 tokens on a small window (5 % would be smaller) is a dispute", () => {
    expect(compareNumeric(8192, 8192 + TOLERANCE_ABS + 1).kind).toBe("dispute");
  });
  it("5 % of the larger value governs on large windows: 1,000,000 vs 1,048,576 is within tolerance", () => {
    const r = compareNumeric(1_000_000, 1_048_576);
    expect(r.kind).toBe("within_tolerance");
    if (r.kind === "within_tolerance") expect(r.published).toBe(1_000_000);
  });
  it("just over 5 % of the larger value is a dispute", () => {
    // 5 % of 1,052,632 ≈ 52,632; delta 52,633 → dispute
    expect(compareNumeric(1_000_000, 1_052_633).kind).toBe("dispute");
    expect(compareNumeric(1_000_000, 1_052_631).kind).toBe("within_tolerance");
  });
  it("is symmetric", () => {
    expect(compareNumeric(200_000, 100_000).kind).toBe("dispute");
    expect(compareNumeric(100_000, 200_000).kind).toBe("dispute");
  });
});

describe("mergeModel", () => {
  it("publishes models.dev unchanged when LiteLLM has no row", () => {
    const r = mergeModel("p", md(), undefined, undefined);
    expect(r.model).toMatchObject({ context_window: 128000, max_output_tokens: 16384, status: "active" });
    expect(r.model.disputed).toBeUndefined();
    expect(r.disputes).toHaveLength(0);
  });

  it("within tolerance: lower value published, both recorded, no dispute", () => {
    const ll: LiteLLMFacts = { key: "p/m", context_window: 131072, max_output_tokens: 16384 };
    const r = mergeModel("p", md(), ll, undefined);
    expect(r.model.context_window).toBe(128000);
    expect(r.tolerance).toEqual([{ provider: "p", model: "m", field: "context_window", models_dev: 128000, litellm: 131072, published: 128000 }]);
    expect(r.disputes).toHaveLength(0);
    expect(r.model.disputed).toBeUndefined();
  });

  it("within tolerance with LiteLLM lower: LiteLLM's value is the one published", () => {
    const ll: LiteLLMFacts = { key: "p/m", context_window: 126000 };
    const r = mergeModel("p", md(), ll, undefined);
    expect(r.model.context_window).toBe(126000);
  });

  it("large delta with no previous release: models.dev's value, disputed: true", () => {
    const ll: LiteLLMFacts = { key: "p/m", context_window: 32768 };
    const r = mergeModel("p", md(), ll, undefined);
    expect(r.model.context_window).toBe(128000);
    expect(r.model.disputed).toBe(true);
    expect(r.disputes).toEqual([
      { provider: "p", model: "m", field: "context_window", models_dev: 128000, litellm: 32768, litellm_key: "p/m", published: 128000, last_known_good: false },
    ]);
  });

  it("large delta with a previous release: last-known-good is published, never the newer number", () => {
    const previous: Model = { ...md(), context_window: 100000, status: "active" };
    const ll: LiteLLMFacts = { key: "p/m", context_window: 32768 };
    const r = mergeModel("p", md({ context_window: 200000 }), ll, previous);
    expect(r.model.context_window).toBe(100000);
    expect(r.model.disputed).toBe(true);
    expect(r.disputes[0]).toMatchObject({ published: 100000, last_known_good: true });
  });

  it("a previous value of 0 (unknown) is not last-known-good; models.dev's value is used", () => {
    const previous: Model = { ...md(), max_output_tokens: 0, status: "active" };
    const ll: LiteLLMFacts = { key: "p/m", max_output_tokens: 65536 };
    const r = mergeModel("p", md(), ll, previous);
    expect(r.model.max_output_tokens).toBe(16384);
    expect(r.disputes[0]).toMatchObject({ field: "max_output_tokens", last_known_good: false });
  });

  it("fills a models.dev 0 (unknown) from LiteLLM without a dispute", () => {
    const ll: LiteLLMFacts = { key: "p/m", max_output_tokens: 32000 };
    const r = mergeModel("p", md({ max_output_tokens: 0 }), ll, undefined);
    expect(r.model.max_output_tokens).toBe(32000);
    expect(r.fills).toEqual([{ provider: "p", model: "m", field: "max_output_tokens", litellm: 32000 }]);
    expect(r.disputes).toHaveLength(0);
  });

  it("boolean difference (tool_call) is a dispute; last-known-good wins when present", () => {
    const ll: LiteLLMFacts = { key: "p/m", tool_call: false };
    const none = mergeModel("p", md(), ll, undefined);
    expect(none.model.tool_call).toBe(true);
    expect(none.disputes[0]).toMatchObject({ field: "tool_call", models_dev: true, litellm: false, published: true, last_known_good: false });

    const previous: Model = { ...md(), tool_call: false, status: "active" };
    const lkg = mergeModel("p", md(), ll, previous);
    expect(lkg.model.tool_call).toBe(false);
    expect(lkg.disputes[0]).toMatchObject({ published: false, last_known_good: true });
  });

  it("modality difference is a dispute per modality; modalities LiteLLM is silent on are never disputed", () => {
    const ll: LiteLLMFacts = { key: "p/m", modalities: { pdf: true, image: true } };
    const r = mergeModel("p", md({ input_modalities: ["text", "image"] }), ll, undefined);
    expect(r.disputes.map((d) => d.field)).toEqual(["input_modalities.pdf"]);
    expect(r.model.input_modalities).toEqual(["text", "image"]); // models.dev's value, no previous
    expect(r.model.disputed).toBe(true);

    const previous: Model = { ...md(), input_modalities: ["text", "image", "pdf"], status: "active" };
    const lkg = mergeModel("p", md({ input_modalities: ["text", "image"] }), ll, previous);
    expect(lkg.model.input_modalities).toEqual(["text", "image", "pdf"]);
  });

  it("text is always kept and modalities are emitted in canonical order", () => {
    const r = mergeModel("p", md({ input_modalities: ["pdf", "image", "text", "audio"] }), undefined, undefined);
    // canonical order is MODALITIES: text, image, audio, video, pdf
    expect(r.model.input_modalities).toEqual(["text", "image", "audio", "pdf"]);
  });
});

describe("mergeRegistries with a LiteLLM index", () => {
  const litellm = indexLiteLLM({
    "gpt-x": { litellm_provider: "openai", mode: "chat", max_input_tokens: 128000, max_output_tokens: 16384, supports_function_calling: true },
    "gemini/gem-x": { litellm_provider: "gemini", mode: "chat", max_input_tokens: 1_000_000 },
    "openrouter/z-ai/glm-5.2": { litellm_provider: "openrouter", mode: "chat", max_input_tokens: 1_048_576 },
    "some-embedding": { litellm_provider: "openai", mode: "embedding", max_input_tokens: 8191 },
  });
  const providers: NormalisedProvider[] = [
    { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", api: "", api_is_template: false, protocol: "openai-compatible", env: [], models: [md({ id: "gpt-x" }), md({ id: "some-embedding" })] },
    { id: "google", name: "Google", npm: "@ai-sdk/google", api: "", api_is_template: false, protocol: "google", env: [], models: [md({ id: "gem-x", context_window: 1_048_576 })] },
    { id: "openrouter", name: "OpenRouter", npm: "@openrouter/ai-sdk-provider", api: "https://openrouter.ai/api/v1", api_is_template: false, protocol: "openai-compatible", env: [], models: [md({ id: "z-ai/glm-5.2", context_window: 1_048_576 })] },
    { id: "zai", name: "Z.AI", npm: "@ai-sdk/openai-compatible", api: "https://api.z.ai/api/paas/v4", api_is_template: false, protocol: "openai-compatible", env: [], models: [md({ id: "glm-5.2", context_window: 1_000_000 })] },
  ];

  it("matches bare openai keys, prefixed gemini keys, and slash-containing openrouter ids; skips non-chat rows", () => {
    const { report } = mergeRegistries(providers, litellm, null);
    expect(report.cross_checked).toBe(3); // gpt-x, gem-x, z-ai/glm-5.2 — not some-embedding (mode embedding), not zai (no litellm provider mapping hit)
    expect(report.disputes).toHaveLength(0);
    expect(report.within_tolerance.map((t) => `${t.provider}/${t.model}`)).toEqual(["google/gem-x"]);
  });

  it("keys are (provider, model): the openrouter route and the zai route keep their own numbers", () => {
    const { providers: out } = mergeRegistries(providers, litellm, null);
    expect(out.find((p) => p.id === "openrouter")!.models[0]!.context_window).toBe(1_048_576);
    expect(out.find((p) => p.id === "zai")!.models[0]!.context_window).toBe(1_000_000);
  });
});

describe("models with no context window in either registry are held back (publication rule: every active row has a real window)", () => {
  const litellm = indexLiteLLM({
    "known-x": { litellm_provider: "openai", mode: "chat", max_input_tokens: 32000, max_output_tokens: 4096 },
  });
  const providers: NormalisedProvider[] = [
    {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      api: "",
      api_is_template: false,
      protocol: "openai-compatible",
      env: [],
      models: [md({ id: "known-x", context_window: 0 }), md({ id: "unknown-y", context_window: 0 }), md({ id: "fine-z", context_window: 8192 })],
    },
  ];

  it("fills from LiteLLM when it can, otherwise records the row in skipped_no_window and does not publish it", () => {
    const { providers: out, report } = mergeRegistries(providers, litellm, null);
    expect(out[0]!.models.map((m) => m.id)).toEqual(["known-x", "fine-z"]);
    expect(out[0]!.models[0]!.context_window).toBe(32000);
    expect(report.skipped_no_window).toEqual([{ provider: "openai", model: "unknown-y", litellm_key: null }]);
  });
});
