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

  it("strips the regional name marker that corresponds to the stripped prefix when synthesising a base entry (real observed case: Nova Premier (US))", () => {
    const out = foldInferenceProfiles([m({ id: "us.amazon.nova-premier-v1:0", name: "Nova Premier (US)" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "amazon.nova-premier-v1:0", name: "Nova Premier", inference_profiles: ["us"] });
  });

  it("strips the regional name marker that corresponds to the stripped prefix (real observed case: Claude Sonnet 4 (APAC))", () => {
    const out = foldInferenceProfiles([m({ id: "apac.anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4 (APAC)" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4", inference_profiles: ["apac"] });
  });

  it("strips every documented regional marker (US, EU, APAC, JP, AU, Global) when synthesising, matching only the group of the prefix that was actually stripped", () => {
    const cases: Array<[string, string, string]> = [
      ["us.foo.a", "Foo A (US)", "Foo A"],
      ["eu.foo.b", "Foo B (EU)", "Foo B"],
      ["apac.foo.c", "Foo C (APAC)", "Foo C"],
      ["jp.foo.d", "Foo D (JP)", "Foo D"],
      ["au.foo.e", "Foo E (AU)", "Foo E"],
      ["global.foo.f", "Foo F (Global)", "Foo F"],
    ];
    for (const [id, name, expected] of cases) {
      const out = foldInferenceProfiles([m({ id, name })]);
      expect(out[0]!.name).toBe(expected);
    }
  });

  it("does not strip a marker that does not match the stripped prefix's own group (picks the first variant honestly, never mislabels)", () => {
    // The id was stripped of "eu.", but the name happens to carry an unrelated "(APAC)" marker — only the
    // eu marker would ever legitimately appear on a eu.-prefixed variant's name, so this is left alone.
    const out = foldInferenceProfiles([m({ id: "eu.foo.g", name: "Foo G (APAC)" })]);
    expect(out[0]!.name).toBe("Foo G (APAC)");
  });

  it("leaves a synthesised name unchanged when it carries no regional marker at all", () => {
    const out = foldInferenceProfiles([m({ id: "us.foo.bar", name: "Bar" })]);
    expect(out[0]!.name).toBe("Bar");
  });

  it("never touches the name of a model that was NOT synthesised (a bare id existed upstream), even if that bare name happens to end in a parenthetical", () => {
    const models = [m({ id: "anthropic.claude-x", name: "Claude X (Preview)" }), m({ id: "us.anthropic.claude-x", name: "Claude X (US)" })];
    const out = foldInferenceProfiles(models);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Claude X (Preview)"); // the bare entry's own name, never overwritten by the variant's
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
