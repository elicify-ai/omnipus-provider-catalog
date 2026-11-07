import { describe, expect, it } from "vitest";

import { normaliseModelsDev, reasoningFrom, type ModelsDevApi } from "../src/sources.js";

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

describe("reasoningFrom (models.dev reasoning flag + typed reasoning_options → {levels, switch})", () => {
  it("no reasoning flag: no object, whatever the options say", () => {
    expect(reasoningFrom(undefined, undefined)).toBeUndefined();
    expect(reasoningFrom(false, [{ type: "effort", values: ["low"] }])).toBeUndefined();
  });

  it("effort values become levels verbatim, in published order (S-46 row: none, low, high, max)", () => {
    expect(reasoningFrom(true, [{ type: "effort", values: ["none", "low", "high", "max"] }])).toEqual({ levels: ["none", "low", "high", "max"], switch: false });
  });

  it("toggle becomes switch: true; effort plus toggle keeps both", () => {
    expect(reasoningFrom(true, [{ type: "toggle" }])).toEqual({ levels: [], switch: true });
    expect(reasoningFrom(true, [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }])).toEqual({ levels: ["low", "high"], switch: true });
  });

  it("budget_tokens only, or a reasoning flag with no options, is the empty object", () => {
    expect(reasoningFrom(true, [{ type: "budget_tokens", min: 1024, max: 63999 }])).toEqual({ levels: [], switch: false });
    expect(reasoningFrom(true, undefined)).toEqual({ levels: [], switch: false });
    expect(reasoningFrom(true, [])).toEqual({ levels: [], switch: false });
  });

  it("budget_tokens next to effort or toggle adds nothing", () => {
    expect(reasoningFrom(true, [{ type: "budget_tokens", min: 1 }, { type: "effort", values: ["low"] }, { type: "toggle" }])).toEqual({ levels: ["low"], switch: true });
  });

  it("drops 'default', null, empty, over-32-character and repeated names; merges several effort entries in first-seen order", () => {
    const long = "x".repeat(33);
    expect(reasoningFrom(true, [{ type: "effort", values: ["default", null, "", long, "low", "high"] }])).toEqual({ levels: ["low", "high"], switch: false });
    expect(reasoningFrom(true, [{ type: "effort", values: ["x".repeat(32)] }])).toEqual({ levels: ["x".repeat(32)], switch: false });
    expect(reasoningFrom(true, [{ type: "effort", values: ["low", "high"] }, { type: "effort", values: ["high", "max"] }])).toEqual({ levels: ["low", "high", "max"], switch: false });
    expect(reasoningFrom(true, [{ type: "effort", values: ["default"] }])).toEqual({ levels: [], switch: false });
  });
});

describe("normaliseModelsDev reasoning object", () => {
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

  it("publishes {levels, switch} for reasoning models and nothing for the rest", () => {
    const { providers } = normaliseModelsDev(api);
    const m = new Map(providers[0]!.models.map((x) => [x.id, x]));
    expect(m.get("efforts")!.reasoning).toEqual({ levels: ["low", "medium", "high"], switch: false });
    expect(m.get("toggle")!.reasoning).toEqual({ levels: [], switch: true });
    expect(m.get("budget")!.reasoning).toEqual({ levels: [], switch: false });
    expect(m.get("off")!.reasoning).toBeUndefined();
    expect(m.get("silent")!.reasoning).toBeUndefined();
    for (const x of m.values()) expect(x).not.toHaveProperty("reasoning_options");
  });
});
