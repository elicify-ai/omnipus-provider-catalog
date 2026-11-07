// Prices are USD per 1 million tokens. models.dev is already in that unit.
// LiteLLM is USD per token and must be converted before compare.
// Expected numbers below are the spec's (FR-014, FR-018), not values read off
// an implementation: Haiku's published input is 1 and its 5-minute cache write
// is 1.25; a missing price is absent; a published 0 stays 0.
import { describe, expect, it } from "vitest";

import { mergeModel } from "../src/merge.js";
import { Model } from "../src/schema.js";
import type { Model as ModelT } from "../src/schema.js";
import { indexLiteLLM, normaliseModelsDev, type ModelsDevApi } from "../src/sources.js";
import type { LiteLLMFacts, NormalisedModel } from "../src/sources.js";

const baseModel = {
  id: "m",
  name: "M",
  tool_call: true,
  context_window: 200000,
  max_output_tokens: 64000,
  input_modalities: ["text"] as ["text"],
  status: "active" as const,
};

function md(over: Partial<NormalisedModel> = {}): NormalisedModel {
  return {
    id: "m",
    name: "M",
    tool_call: true,
    context_window: 200000,
    max_output_tokens: 64000,
    input_modalities: ["text"],
    ...over,
  };
}

function provider(models: ModelsDevApi[string]["models"]): ModelsDevApi {
  return {
    acme: {
      id: "acme",
      name: "Acme",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.acme.example/v1",
      models,
    },
  };
}

describe("models.dev cost is copied through, never invented", () => {
  it("keeps a cache_write of 0 and does not turn a missing cache_read into 0", () => {
    const { providers } = normaliseModelsDev(
      provider({
        m: {
          id: "m",
          name: "M",
          tool_call: true,
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: 0.6, output: 2.2, cache_read: 0.11, cache_write: 0 },
        },
      }),
    );
    expect(providers[0]!.models[0]!.cost).toEqual({
      input: 0.6,
      output: 2.2,
      cache_read: 0.11,
      cache_write: 0,
    });
    expect(providers[0]!.models[0]!.cost).not.toHaveProperty("cache_read", undefined);
    expect("cache_write_1h" in (providers[0]!.models[0]!.cost ?? {})).toBe(false);
  });

  it("publishes a model with no cost object without a price and without zeros", () => {
    const { providers } = normaliseModelsDev(
      provider({
        m: {
          id: "m",
          name: "M",
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
        },
      }),
    );
    expect(providers[0]!.models[0]).not.toHaveProperty("cost");
  });

  it("drops audio prices (not part of the published cost) and still keeps input", () => {
    const { providers } = normaliseModelsDev(
      provider({
        m: {
          id: "m",
          name: "M",
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: 1, output: 5, input_audio: 10, output_audio: 20 },
        },
      }),
    );
    const cost = providers[0]!.models[0]!.cost;
    expect(cost).toEqual({ input: 1, output: 5 });
    expect(cost).not.toHaveProperty("input_audio");
    expect(cost).not.toHaveProperty("output_audio");
  });

  it("passes tier.size through unchanged and does not invent a boundary", () => {
    // Anthropic haiku-5-5 uses 100000 ("up to 100000" is still the base rate).
    // Vercel encodes the same idea as 200001. Flattening either number would
    // pick one inclusive/exclusive rule for every source.
    const { providers } = normaliseModelsDev(
      provider({
        haiku: {
          id: "haiku",
          name: "Haiku",
          limit: { context: 200000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 0.1,
            output: 0.5,
            cache_read: 0.01,
            cache_write: 0.125,
            tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, tier: { type: "context", size: 100000 } }],
          },
        },
        grok: {
          id: "grok",
          name: "Grok",
          limit: { context: 256000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 1.25,
            output: 2.5,
            tiers: [{ input: 2.5, output: 5, tier: { type: "context", size: 200001 } }],
            context_over_200k: { input: 2.5, output: 5 },
          },
        },
      }),
    );
    const haiku = providers[0]!.models.find((m) => m.id === "haiku")!;
    const grok = providers[0]!.models.find((m) => m.id === "grok")!;
    expect(haiku.cost!.tiers).toEqual([
      {
        input: 0.5,
        output: 2.5,
        cache_read: 0.05,
        cache_write: 0.625,
        tier: { type: "context", size: 100000 },
      },
    ]);
    expect(haiku.cost!.tiers![0]!.tier).not.toHaveProperty("boundary");
    expect(grok.cost!.tiers![0]!.tier).toEqual({ type: "context", size: 200001 });
    expect(grok.cost!.context_over_200k).toEqual({ input: 2.5, output: 5 });
    expect(grok.cost!.tiers).toHaveLength(1);
  });

  it("keeps a source boundary when the source states one, and does not rewrite size", () => {
    const { providers } = normaliseModelsDev(
      provider({
        over: {
          id: "over",
          name: "Over",
          limit: { context: 200000, output: 100 },
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 1,
            output: 5,
            tiers: [{ input: 2, output: 10, tier: { type: "context", size: 100000, boundary: "above" } }],
          },
        },
        incl: {
          id: "incl",
          name: "Incl",
          limit: { context: 200000, output: 100 },
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 1,
            output: 5,
            tiers: [{ input: 2, output: 10, tier: { type: "context", size: 100000, boundary: "at_least" } }],
          },
        },
      }),
    );
    const over = providers[0]!.models.find((m) => m.id === "over")!;
    const incl = providers[0]!.models.find((m) => m.id === "incl")!;
    expect(over.cost!.tiers![0]!.tier).toEqual({ type: "context", size: 100000, boundary: "above" });
    expect(incl.cost!.tiers![0]!.tier).toEqual({ type: "context", size: 100000, boundary: "at_least" });
  });

  it("rejects a negative cache price instead of publishing the other prices with that field absent", () => {
    // Absent cache_write means "price writes at the input rate". A negative
    // number is not that, and it is not a real zero either.
    const { providers, cost_rejected } = normaliseModelsDev(
      provider({
        m: {
          id: "m",
          name: "M",
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: 1, output: 5, cache_write: -1 },
        },
      }),
    );
    expect(providers[0]!.models[0]).not.toHaveProperty("cost");
    expect(cost_rejected).toEqual([
      { provider: "acme", model: "m", reason: "cost.cache_write is not a finite number >= 0; the model is published without a price" },
    ]);
  });
});

describe("LiteLLM per-token prices convert to per million before anything else", () => {
  it("converts Haiku's per-token rates to input 1, cache_write 1.25, cache_read 0.1", () => {
    const index = indexLiteLLM({
      "claude-haiku-4-5": {
        litellm_provider: "anthropic",
        mode: "chat",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000005,
        cache_read_input_token_cost: 0.0000001,
        cache_creation_input_token_cost: 0.00000125,
        cache_creation_input_token_cost_above_1hr: 0.000002,
        // Batch rates are a different product. They must not become the published price.
        input_cost_per_token_batches: 0.0000005,
        output_cost_per_token_batches: 0.0000025,
      },
    });
    expect(index.get("anthropic|claude-haiku-4-5")!.cost).toEqual({
      input: 1,
      output: 5,
      cache_read: 0.1,
      cache_write: 1.25,
      cache_write_1h: 2,
    });
  });

  it("keeps a LiteLLM cache price of 0 and does not invent 0 for a missing field", () => {
    const index = indexLiteLLM({
      "glm-5.2": {
        litellm_provider: "zai",
        mode: "chat",
        input_cost_per_token: 0.0000014,
        output_cost_per_token: 0.0000044,
        cache_read_input_token_cost: 0.00000026,
        cache_creation_input_token_cost: 0,
      },
    });
    const cost = index.get("zai|glm-5.2")!.cost!;
    expect(cost.cache_write).toBe(0);
    expect(cost).not.toHaveProperty("cache_write_1h");
    expect(cost).not.toHaveProperty("reasoning");
  });
});

describe("mergeModel cost cross-check (5% relative, never the 4,096 token floor)", () => {
  it("publishes models.dev prices, including cache_write 0, when LiteLLM has no price", () => {
    const model = {
      ...md(),
      cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 0 },
    } as NormalisedModel;
    const r = mergeModel("anthropic", model, undefined, undefined);
    expect(r.model.cost).toEqual({ input: 1, output: 5, cache_read: 0.1, cache_write: 0 });
    expect(r.model.disputed).toBeUndefined();
    expect(r.fills).toHaveLength(0);
    expect(r.disputes).toHaveLength(0);
  });

  it("omits cost when neither source has a price", () => {
    const r = mergeModel("p", md(), { key: "p/m", context_window: 200000 }, undefined);
    expect(r.model).not.toHaveProperty("cost");
  });

  it("fills a missing models.dev price from LiteLLM and records the fill", () => {
    const ll = {
      key: "acme/m",
      cost: { input: 2, output: 8, cache_read: 0.2 },
    } as LiteLLMFacts;
    const r = mergeModel("acme", md(), ll, undefined);
    expect(r.model.cost).toEqual({ input: 2, output: 8, cache_read: 0.2 });
    expect(r.model.cost).not.toHaveProperty("cache_write");
    expect(r.fills.map((f) => f.field).sort()).toEqual(["cost.cache_read", "cost.input", "cost.output"]);
    expect(r.disputes).toHaveLength(0);
    expect(r.model.disputed).toBeUndefined();
  });

  it("fills cache_write_1h from LiteLLM when models.dev omits it, and does not invent it when LiteLLM omits it", () => {
    const with1h = mergeModel(
      "anthropic",
      { ...md(), cost: { input: 1, output: 5, cache_write: 1.25 } } as NormalisedModel,
      { key: "anthropic/m", cost: { input: 1, output: 5, cache_write: 1.25, cache_write_1h: 2 } } as LiteLLMFacts,
      undefined,
    );
    expect(with1h.model.cost!.cache_write_1h).toBe(2);
    expect(with1h.fills).toEqual([
      { provider: "anthropic", model: "m", field: "cost.cache_write_1h", litellm: 2 },
    ]);

    const without = mergeModel(
      "anthropic",
      { ...md(), cost: { input: 1, output: 5, cache_write: 1.25 } } as NormalisedModel,
      { key: "anthropic/m", cost: { input: 1, output: 5, cache_write: 1.25 } } as LiteLLMFacts,
      undefined,
    );
    expect(without.model.cost).not.toHaveProperty("cache_write_1h");
    expect(without.fills).toHaveLength(0);
  });

  it("within 5% of the larger price publishes the lower value and is not a dispute", () => {
    // 1.00 vs 1.04: delta 0.04, 5% of 1.04 is 0.052. Lower value is published.
    const r = mergeModel(
      "p",
      { ...md(), cost: { input: 1, output: 5 } } as NormalisedModel,
      { key: "p/m", cost: { input: 1.04, output: 5 } } as LiteLLMFacts,
      undefined,
    );
    expect(r.model.cost!.input).toBe(1);
    expect(r.model.disputed).toBeUndefined();
    expect(r.tolerance).toEqual([
      { provider: "p", model: "m", field: "cost.input", models_dev: 1, litellm: 1.04, published: 1 },
    ]);
  });

  it("exactly 5% of the larger price is still within tolerance", () => {
    // 0.95 vs 1.00: delta = 0.05 * the larger value.
    const r = mergeModel(
      "p",
      { ...md(), cost: { input: 0.95, output: 5 } } as NormalisedModel,
      { key: "p/m", cost: { input: 1, output: 5 } } as LiteLLMFacts,
      undefined,
    );
    expect(r.model.cost!.input).toBe(0.95);
    expect(r.disputes).toHaveLength(0);
  });

  it("a price gap beyond 5% is a dispute even when the dollar gap is far below 4,096", () => {
    // 1.00 vs 1.06: delta 0.06 > 5% of 1.06 (0.053). The token rule would call
    // this "within tolerance" because 0.06 < 4,096. Prices must not.
    const r = mergeModel(
      "p",
      { ...md(), cost: { input: 1, output: 5, cache_write: 1.25 } } as NormalisedModel,
      { key: "p/m", cost: { input: 1.06, output: 5, cache_write: 1.25 } } as LiteLLMFacts,
      undefined,
    );
    expect(r.model.cost!.input).toBe(1);
    expect(r.model.disputed).toBe(true);
    expect(r.disputes).toEqual([
      {
        provider: "p",
        model: "m",
        field: "cost.input",
        models_dev: 1,
        litellm: 1.06,
        litellm_key: "p/m",
        published: 1,
        last_known_good: false,
      },
    ]);
    expect(r.model.cost!.cache_write).toBe(1.25);
  });

  it("a price dispute with a previous release publishes that price, and a previous 0 counts", () => {
    const previous = {
      ...baseModel,
      cost: { input: 0, output: 4, cache_write: 0 },
    } as ModelT;
    const r = mergeModel(
      "p",
      { ...md(), cost: { input: 1, output: 5, cache_write: 1.25 } } as NormalisedModel,
      { key: "p/m", cost: { input: 2, output: 5, cache_write: 1.25 } } as LiteLLMFacts,
      previous,
    );
    expect(r.model.cost!.input).toBe(0);
    expect(r.disputes[0]).toMatchObject({ field: "cost.input", published: 0, last_known_good: true });
  });

  it("a models.dev cache price of 0 is not overwritten by a missing LiteLLM field and is a dispute against a positive LiteLLM price", () => {
    const kept = mergeModel(
      "zai",
      { ...md(), cost: { input: 1, output: 3.2, cache_read: 0.2, cache_write: 0 } } as NormalisedModel,
      { key: "zai/m", cost: { input: 1, output: 3.2, cache_read: 0.2 } } as LiteLLMFacts,
      undefined,
    );
    expect(kept.model.cost!.cache_write).toBe(0);
    expect(kept.disputes).toHaveLength(0);

    const disputed = mergeModel(
      "zai",
      { ...md(), cost: { input: 1, output: 3.2, cache_write: 0 } } as NormalisedModel,
      { key: "zai/m", cost: { input: 1, output: 3.2, cache_write: 1.25 } } as LiteLLMFacts,
      undefined,
    );
    expect(disputed.model.cost!.cache_write).toBe(0);
    expect(disputed.model.disputed).toBe(true);
    expect(disputed.disputes[0]).toMatchObject({ field: "cost.cache_write", models_dev: 0, litellm: 1.25, published: 0 });
  });

  it("keeps tiers and context_over_200k while a base price is cross-checked", () => {
    const r = mergeModel(
      "p",
      {
        ...md(),
        cost: {
          input: 1,
          output: 5,
          tiers: [{ input: 2, output: 10, tier: { type: "context", size: 100000 } }],
          context_over_200k: { input: 2, output: 10 },
        },
      } as NormalisedModel,
      { key: "p/m", cost: { input: 1, output: 5 } } as LiteLLMFacts,
      undefined,
    );
    expect(r.model.cost!.tiers).toEqual([{ input: 2, output: 10, tier: { type: "context", size: 100000 } }]);
    expect(r.model.cost!.context_over_200k).toEqual({ input: 2, output: 10 });
    expect(r.model.cost!.tiers![0]!.tier).not.toHaveProperty("boundary");
  });
});

describe("schema accepts an optional cost and rejects a bad one", () => {
  it("accepts a model with no cost", () => {
    expect(Model.safeParse(baseModel).success).toBe(true);
  });

  it("accepts a zero cache price, tiers, the legacy alias, and both boundary values", () => {
    const parsed = Model.safeParse({
      ...baseModel,
      cost: {
        input: 1,
        output: 5,
        cache_read: 0.1,
        cache_write: 0,
        cache_write_1h: 2,
        tiers: [
          { input: 2, output: 10, cache_write: 2.5, tier: { type: "context", size: 100000, boundary: "above" } },
          { input: 3, output: 15, tier: { type: "context", size: 200001, boundary: "at_least" } },
        ],
        context_over_200k: { input: 2, output: 10, cache_read: 0.2, cache_write: 0 },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cost!.cache_write).toBe(0);
      expect(parsed.data.cost!.tiers![0]!.tier.boundary).toBe("above");
      expect(parsed.data.cost!.tiers![1]!.tier).toEqual({ type: "context", size: 200001, boundary: "at_least" });
    }
  });

  it("rejects a negative price and an unknown audio field", () => {
    const negative = Model.safeParse({ ...baseModel, cost: { input: -1, output: 5 } });
    expect(negative.success).toBe(false);
    const audio = Model.safeParse({ ...baseModel, cost: { input: 1, output: 5, input_audio: 10 } });
    expect(audio.success).toBe(false);
  });
});
