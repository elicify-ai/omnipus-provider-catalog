import { describe, expect, it } from "vitest";

import { foldInferenceProfiles } from "../src/inference-profiles.js";
import type { Model } from "../src/schema.js";

const m = (over: Partial<Model> = {}): Model => ({
  id: "x",
  name: "X",
  tool_call: true,
  context_window: 100,
  max_output_tokens: 10,
  input_modalities: ["text"],
  status: "active",
  ...over,
});

describe("foldInferenceProfiles", () => {
  it("folds region-prefixed variants into the base model's inference_profiles, in canonical group order, and drops the duplicates", () => {
    const models = [
      m({ id: "apac.anthropic.claude-sonnet-4-6", name: "Claude Sonnet 4.6" }),
      m({ id: "anthropic.claude-sonnet-4-6", name: "Claude Sonnet 4.6" }),
      m({ id: "eu.anthropic.claude-sonnet-4-6", name: "Claude Sonnet 4.6" }),
    ];
    const out = foldInferenceProfiles(models);
    expect(out.map((x) => x.id)).toEqual(["anthropic.claude-sonnet-4-6"]);
    expect(out[0]!.inference_profiles).toEqual(["eu", "apac"]); // canonical order: us, eu, apac, jp, au, global
    expect(out[0]!.name).toBe("Claude Sonnet 4.6");
  });

  it("synthesises a base entry from the first variant when only prefixed variants exist upstream", () => {
    const models = [
      m({ id: "us.deepseek.v4", name: "DeepSeek V4", context_window: 500, release_date: "2026-01-01" }),
      m({ id: "eu.deepseek.v4", name: "DeepSeek V4", context_window: 999 }),
    ];
    const out = foldInferenceProfiles(models);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "deepseek.v4", name: "DeepSeek V4", context_window: 500, release_date: "2026-01-01", inference_profiles: ["us", "eu"] });
  });

  it("keeps arn:-style ids untouched, never treating them as a prefixed variant", () => {
    const arnId = "arn:aws:bedrock:us-east-1:111122223333:provisioned-model/abcd1234";
    const models = [m({ id: arnId })];
    expect(foldInferenceProfiles(models)).toEqual(models);
  });

  it("leaves a model with an unrecognised prefix (not an AWS-documented cross-region group, e.g. ca. or in.) as its own standalone model", () => {
    const models = [m({ id: "ca.amazon.nova-lite-v1:0" }), m({ id: "in.openai.gpt-5.6-luna" })];
    const out = foldInferenceProfiles(models);
    expect(out.map((x) => x.id).sort()).toEqual(["ca.amazon.nova-lite-v1:0", "in.openai.gpt-5.6-luna"]);
    expect(out.every((x) => x.inference_profiles === undefined)).toBe(true);
  });

  it("a bare model with no prefixed variants passes through unchanged", () => {
    const models = [m({ id: "amazon.nova-pro-v1:0" })];
    expect(foldInferenceProfiles(models)).toEqual(models);
  });

  it("collects every known group prefix present (including global), sorted in canonical order", () => {
    const models = [m({ id: "meta.llama-5" }), m({ id: "global.meta.llama-5" }), m({ id: "jp.meta.llama-5" }), m({ id: "au.meta.llama-5" }), m({ id: "us.meta.llama-5" })];
    const out = foldInferenceProfiles(models);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("meta.llama-5");
    expect(out[0]!.inference_profiles).toEqual(["us", "jp", "au", "global"]);
  });

  it("does not cross-contaminate base ids that only share a prefix textually", () => {
    const models = [m({ id: "us.anthropic.claude-a" }), m({ id: "us.anthropic.claude-b" }), m({ id: "anthropic.claude-a" })];
    const out = foldInferenceProfiles(models);
    const byId = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(Object.keys(byId).sort()).toEqual(["anthropic.claude-a", "anthropic.claude-b"]);
    expect(byId["anthropic.claude-a"]!.inference_profiles).toEqual(["us"]);
    expect(byId["anthropic.claude-b"]!.inference_profiles).toEqual(["us"]); // synthesised, no bare upstream id
  });
});
