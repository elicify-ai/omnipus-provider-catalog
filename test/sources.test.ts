import { describe, expect, it } from "vitest";

import { normaliseModelsDev, type ModelsDevApi } from "../src/sources.js";

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
