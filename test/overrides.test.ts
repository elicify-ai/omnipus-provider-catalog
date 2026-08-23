import { describe, expect, it } from "vitest";

import { deriveLocality, finalizeProviders, isLocalHost } from "../src/finalize.js";
import type { DisputeRecord, MergedProvider } from "../src/merge.js";
import { applyOverrides, type Overrides, type WorkingProvider } from "../src/overrides.js";

const registryProvider = (id: string, api: string, modelIds: string[]): MergedProvider => ({
  id,
  name: id.toUpperCase(),
  npm: "@ai-sdk/openai-compatible",
  api,
  api_is_template: false,
  protocol: "openai-compatible",
  env: [`${id.toUpperCase()}_API_KEY`],
  models: modelIds.map((m) => ({ id: m, name: m, tool_call: true, context_window: 128000, max_output_tokens: 8192, input_modalities: ["text"], status: "active" as const })),
});

const none: Overrides = { providers: {}, models: {}, local: {} };

describe("applyOverrides", () => {
  it("provider overrides win over the registry and set fields the registries lack", () => {
    const reg = [registryProvider("groq", "", ["llama"])];
    const { providers, report } = applyOverrides(reg as WorkingProvider[], {
      ...none,
      providers: { groq: { reason: "docs", api: "https://api.groq.com/openai/v1", tier: "popular", auth_methods: ["api_key", "sign_in"], aliases: ["g"] } },
    }, [], reg);
    expect(providers[0]).toMatchObject({ api: "https://api.groq.com/openai/v1", tier: "popular", auth_methods: ["api_key", "sign_in"], aliases: ["g"] });
    expect(report.providers_applied).toEqual(["groq"]);
  });

  it("refuses an override for a provider that is not in the merged document", () => {
    expect(() => applyOverrides([], { ...none, providers: { nope: { reason: "r", tier: "popular" } } }, [], [])).toThrow(/not a provider/);
  });

  it("a model override resolves the dispute on the field it sets and clears `disputed` when none remain", () => {
    const reg = [registryProvider("zai", "https://api.z.ai/api/paas/v4", ["glm-5.2"])];
    reg[0]!.models[0]!.disputed = true;
    const disputes: DisputeRecord[] = [
      { provider: "zai", model: "glm-5.2", field: "context_window", models_dev: 1_000_000, litellm: 200_000, litellm_key: "zai/glm-5.2", published: 1_000_000, last_known_good: false },
      { provider: "zai", model: "glm-5.2", field: "input_modalities.pdf", models_dev: false, litellm: true, litellm_key: "zai/glm-5.2", published: false, last_known_good: false },
    ];
    const { providers, disputes: remaining, report } = applyOverrides(reg as WorkingProvider[], {
      ...none,
      models: { zai: { "glm-5.2": { reason: "Issue #12 adjudicated", context_window: 204800 } } },
    }, disputes, reg);
    const m = providers[0]!.models[0]!;
    expect(m.context_window).toBe(204800);
    expect(m.disputed).toBe(true); // the pdf dispute is still open
    expect(remaining.map((d) => d.field)).toEqual(["input_modalities.pdf"]);
    expect(report.disputes_resolved_by_override.map((d) => d.field)).toEqual(["context_window"]);

    const second = applyOverrides(reg as WorkingProvider[], {
      ...none,
      models: { zai: { "glm-5.2": { reason: "Issue #13", context_window: 204800, input_modalities: ["text", "pdf"] } } },
    }, disputes, reg);
    expect(second.disputes).toEqual([]);
    expect(second.providers[0]!.models[0]!.disputed).toBeUndefined();
  });

  it("a model override can add a legacy model only when it is complete", () => {
    const reg = [registryProvider("openai", "https://api.openai.com/v1", ["gpt-x"])];
    expect(() => applyOverrides(reg as WorkingProvider[], { ...none, models: { openai: { "gpt-old": { reason: "r", context_window: 8192 } } } }, [], reg)).toThrow(/needs context_window/);
    const ok = applyOverrides(reg as WorkingProvider[], {
      ...none,
      models: { openai: { "gpt-old": { reason: "r", context_window: 8192, max_output_tokens: 8192, input_modalities: ["text"], tool_call: true, status: "retired" } } },
    }, [], reg);
    expect(ok.providers[0]!.models.map((m) => [m.id, m.status])).toEqual([["gpt-x", "active"], ["gpt-old", "retired"]]);
    expect(ok.report.models_created).toEqual([{ provider: "openai", model: "gpt-old" }]);
  });

  it("local providers are created with models copied from a registry row (filtered) or typed explicitly, or merged over an existing row", () => {
    const reg = [registryProvider("openai", "https://api.openai.com/v1", ["gpt-5", "gpt-5.3-codex", "o3"]), registryProvider("github-copilot", "https://api.githubcopilot.com", ["gpt-5"])];
    const { providers, report } = applyOverrides(reg as WorkingProvider[], {
      ...none,
      local: {
        "codex-cli": { reason: "r", name: "Codex CLI", api: "", protocol: "cli", cli_kind: "codex", env: [], auth_methods: ["sign_in"], models_from: "openai", model_ids: ["re:codex"] },
        ollama: { reason: "r", name: "Ollama", api: "http://localhost:11434/v1", protocol: "ollama", env: [] },
        avian: { reason: "r", name: "Avian", api: "https://api.avian.io/v1", protocol: "openai-compatible", env: [], models: [{ id: "x", name: "X", tool_call: true, context_window: 1, max_output_tokens: 1, input_modalities: ["text"] }] },
        "github-copilot": { reason: "r", name: "GitHub Copilot", api: "https://api.githubcopilot.com", protocol: "cli", cli_kind: "copilot", env: [], auth_methods: ["sign_in"] },
      },
    }, [], reg);
    const by = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(by["codex-cli"]!.models.map((m) => m.id)).toEqual(["gpt-5.3-codex"]);
    expect(by["codex-cli"]!.from_local_file).toBe(true);
    expect(by["ollama"]!.models).toEqual([]);
    expect(by["avian"]!.models[0]).toMatchObject({ id: "x", status: "active" });
    expect(by["github-copilot"]).toMatchObject({ protocol: "cli", cli_kind: "copilot", auth_methods: ["sign_in"] });
    expect(by["github-copilot"]!.models.map((m) => m.id)).toEqual(["gpt-5"]); // registry models kept on merge
    expect(report.local_rows_created.sort()).toEqual(["avian", "codex-cli", "ollama"]);
    expect(report.local_rows_merged).toEqual(["github-copilot"]);
  });
});

describe("finalizeProviders", () => {
  const resize = { default: { long_edge_px: 7680, max_bytes: 10485760 }, providers: { openai: { long_edge_px: 8000, max_bytes: 20971520 } } };

  it("fills defaults (company = name, tier standard, auth api_key, aliases []), joins resize limits, sorts, and never publishes locality", () => {
    const w: WorkingProvider[] = [registryProvider("zai", "https://api.z.ai/api/paas/v4", ["b", "a"]), registryProvider("openai", "https://api.openai.com/v1", ["m"])];
    const { providers } = finalizeProviders(w, resize);
    expect(providers.map((p) => p.id)).toEqual(["openai", "zai"]);
    expect(providers[0]!.resize_limits).toEqual(resize.providers.openai);
    expect(providers[1]).toMatchObject({ company: "ZAI", tier: "standard", auth_methods: ["api_key"], aliases: [], resize_limits: resize.default });
    expect(providers[1]!.models.map((m) => m.id)).toEqual(["a", "b"]);
    expect("locality" in providers[1]!).toBe(false);
  });

  it("a row with no protocol, no URL, or a non-https/private URL becomes unsupported / deployment-url unless already unsupported", () => {
    const noProto: WorkingProvider = { ...registryProvider("azure", "", ["m"]), npm: "@ai-sdk/azure", protocol: "" };
    const template: WorkingProvider = { ...registryProvider("databricks", "", ["m"]), api_is_template: true };
    const iam: WorkingProvider = { ...registryProvider("amazon-bedrock", "", ["m"]), protocol: "", tier: "unsupported", unsupported_reason: "cloud-iam" };
    const loop: WorkingProvider = registryProvider("atomic-chat", "http://127.0.0.1:1337/v1", ["m"]);
    const cliNoUrl: WorkingProvider = { ...registryProvider("copilot-x", "", ["m"]), protocol: "cli", cli_kind: "copilot" };
    const cli: WorkingProvider = { ...registryProvider("codex-cli", "https://chatgpt.com/backend-api/codex", ["m"]), protocol: "cli", cli_kind: "codex" };
    const local: WorkingProvider = registryProvider("vllm", "http://localhost:8000/v1", []);
    const { providers, report } = finalizeProviders([noProto, template, iam, loop, cliNoUrl, cli, local], resize);
    const by = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(by["azure"]).toMatchObject({ tier: "unsupported", unsupported_reason: "deployment-url" });
    expect(by["databricks"]).toMatchObject({ tier: "unsupported", unsupported_reason: "deployment-url" });
    expect(by["amazon-bedrock"]).toMatchObject({ tier: "unsupported", unsupported_reason: "cloud-iam" });
    expect(by["atomic-chat"]).toMatchObject({ tier: "unsupported", unsupported_reason: "deployment-url", api: "" }); // URL cleared: Omnipus would reject the whole document
    expect(by["copilot-x"]).toMatchObject({ tier: "unsupported", unsupported_reason: "deployment-url" });
    expect(by["codex-cli"]).toMatchObject({ tier: "standard", protocol: "cli" });
    expect(by["vllm"]).toMatchObject({ tier: "standard", api: "http://localhost:8000/v1" }); // local by the spec rule
    expect(report.auto_unsupported.map((a) => a.id)).toEqual(["atomic-chat", "azure", "copilot-x", "databricks"]);
  });
});

describe("locality", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["10.0.0.5", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["api.openai.com", false],
    ["ollama", true],
    ["::1", true],
    ["fd00::1", true],
    ["2606:4700::1", false],
  ])("isLocalHost(%s) = %s", (host, expected) => {
    expect(isLocalHost(host)).toBe(expected);
  });

  it("derives local exactly as the spec does (FR-039): ollama protocol or the ids vllm / lmstudio; everything else is cloud", () => {
    expect(deriveLocality({ id: "x", protocol: "ollama" })).toBe("local");
    expect(deriveLocality({ id: "vllm", protocol: "openai-compatible" })).toBe("local");
    expect(deriveLocality({ id: "lmstudio", protocol: "openai-compatible" })).toBe("local");
    expect(deriveLocality({ id: "litellm", protocol: "openai-compatible" })).toBe("cloud"); // a loopback URL here is NOT exempt
    expect(deriveLocality({ id: "x", protocol: "openai-compatible" })).toBe("cloud");
  });
});
