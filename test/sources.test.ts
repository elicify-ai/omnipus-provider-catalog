import { describe, expect, it } from "vitest";

import { normaliseModelsDev, reasoningOptionsFrom, type ModelsDevApi } from "../src/sources.js";

describe("normaliseModelsDev modality filters", () => {
  const api: ModelsDevApi = {
    acme: {
      id: "acme",
      name: "Acme",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.acme.example/v1",
      models: {
        chat: { id: "chat", name: "Chat", limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] } },
        "no-output-list": { id: "no-output-list", name: "NoOut", limit: { context: 1000, output: 100 }, modalities: { input: ["text"] } },
        "image-gen": { id: "image-gen", name: "Img", modalities: { input: ["text", "image"], output: ["image"] } },
        "video-gen": { id: "video-gen", name: "Vid", modalities: { input: ["text"], output: ["video"] } },
        tts: { id: "tts", name: "TTS", modalities: { input: ["text"], output: ["audio"] } },
        "image-in-only": { id: "image-in-only", name: "ImgIn", limit: { context: 10 }, modalities: { input: ["image"], output: ["text"] } },
      },
    },
  };

  it("keeps text-in/text-out models (an absent output list counts as text) and skips generators and non-text-input rows", () => {
    const { providers, skipped } = normaliseModelsDev(api);
    expect(providers[0]!.models.map((m) => m.id)).toEqual(["chat", "no-output-list"]);
    expect(skipped.map((s) => s.model).sort()).toEqual(["image-gen", "image-in-only", "tts", "video-gen"]);
    expect(skipped.find((s) => s.model === "image-gen")!.reason).toMatch(/output modalities/);
    expect(skipped.find((s) => s.model === "image-in-only")!.reason).toMatch(/input modalities/);
  });
});

describe("reasoningOptionsFrom (models.dev's typed reasoning_options descriptors → named effort levels)", () => {
  it("maps the effort shape to its values verbatim, keeping models.dev's ascending effort order", () => {
    expect(reasoningOptionsFrom([{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }])).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });

  it("drops the shapes that carry no named levels: a token budget, a bare toggle and an empty list", () => {
    expect(reasoningOptionsFrom([{ type: "budget_tokens", min: 1024 }])).toBeUndefined();
    expect(reasoningOptionsFrom([{ type: "budget_tokens", min: 0, max: 63999 }])).toBeUndefined();
    expect(reasoningOptionsFrom([{ type: "toggle" }])).toBeUndefined();
    expect(reasoningOptionsFrom([])).toBeUndefined();
    expect(reasoningOptionsFrom(undefined)).toBeUndefined();
  });

  it("picks the effort entry out of a mixed list (toggle + effort)", () => {
    expect(reasoningOptionsFrom([{ type: "toggle" }, { type: "effort", values: ["low", "medium", "xhigh"] }])).toEqual(["low", "medium", "xhigh"]);
  });

  it("drops null and empty-string entries seen live inside values; nothing usable left → absent", () => {
    expect(reasoningOptionsFrom([{ type: "effort", values: [null, "low", "medium", "high"] }])).toEqual(["low", "medium", "high"]);
    expect(reasoningOptionsFrom([{ type: "effort", values: [null, ""] }])).toBeUndefined();
  });

  it("merges multiple effort entries without duplicates, keeping the first occurrence's position", () => {
    expect(reasoningOptionsFrom([{ type: "effort", values: ["low", "high"] }, { type: "effort", values: ["high", "max"] }])).toEqual(["low", "high", "max"]);
  });
});

describe("normaliseModelsDev reasoning fields", () => {
  const chat = { limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] } };
  const api: ModelsDevApi = {
    acme: {
      id: "acme",
      name: "Acme",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.acme.example/v1",
      models: {
        efforts: { id: "efforts", name: "Efforts", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }], ...chat },
        toggle: { id: "toggle", name: "Toggle", reasoning: true, reasoning_options: [{ type: "toggle" }], ...chat },
        budget: { id: "budget", name: "Budget", reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024 }], ...chat },
        off: { id: "off", name: "Off", reasoning: false, ...chat },
        silent: { id: "silent", name: "Silent", ...chat },
      },
    },
  };

  it("carries reasoning: true plus the flat named levels only when upstream publishes effort values", () => {
    const { providers } = normaliseModelsDev(api);
    const m = new Map(providers[0]!.models.map((x) => [x.id, x]));
    // effort shape: named levels, ascending, as published
    expect(m.get("efforts")!.reasoning).toBe(true);
    expect(m.get("efforts")!.reasoning_options).toEqual(["low", "medium", "high"]);
    // controlled but unnamed (toggle / budget_tokens): reasoning yes, no invented names
    expect(m.get("toggle")!.reasoning).toBe(true);
    expect(m.get("toggle")!.reasoning_options).toBeUndefined();
    expect(m.get("budget")!.reasoning).toBe(true);
    expect(m.get("budget")!.reasoning_options).toBeUndefined();
    // no reasoning support: both fields absent, never false
    expect(m.get("off")!.reasoning).toBeUndefined();
    expect(m.get("off")!.reasoning_options).toBeUndefined();
    expect(m.get("silent")!.reasoning).toBeUndefined();
    expect(m.get("silent")!.reasoning_options).toBeUndefined();
  });
});
