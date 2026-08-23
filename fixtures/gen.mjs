#!/usr/bin/env node
// Generates fixtures/valid-minimal.json and fixtures/invalid/<CHECK>.json —
// one invalid document per validator check, each produced by a single targeted
// mutation of the minimal valid document. Run: `npm run fixtures`.
//
// All URLs, names and numbers are illustrative placeholders chosen to satisfy the
// spec's shape rules; they are NOT verified registry values (no upstream registry
// is fetched here — OpenRouter data in particular is never copied).

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS, MAX_DOCUMENT_BYTES } from "../validator/validate-spec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resize = { long_edge_px: 7680, max_bytes: 10485760 };

function cloud(id, name, api, extra = {}) {
  return { id, name, api, protocol: "openai-compatible", env: `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`, tier: "standard", auth_methods: ["api_key"], company: name, resize_limits: { ...resize }, models: [], ...extra };
}
function unsupported(id, name, reason) {
  return { id, name, api: "", protocol: "", tier: "unsupported", unsupported_reason: reason, auth_methods: ["api_key"], company: name, resize_limits: { ...resize }, models: [] };
}
const model = (id, name, cw, out, extra = {}) => ({ id, name, context_window: cw, max_output_tokens: out, input_modalities: ["text"], tool_call: true, status: "active", ...extra });

export function validMinimal() {
  return {
    schema_version: "2.0.0",
    version: "v2026.8.23",
    updated_at: "2026-08-23T06:00:00Z",
    source: "fixture: models.dev@0000000 litellm@0000000 overrides@0000000 (placeholder ids)",
    default_resize_limits: { ...resize },
    providers: [
      // --- popular (FR-018) ---
      cloud("openai", "OpenAI", "https://api.openai.com/v1", { tier: "popular", models: [model("gpt-4o", "GPT-4o", 128000, 16384, { input_modalities: ["text", "image", "pdf"], release_date: "2024-05-13" })] }),
      cloud("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", { tier: "popular", models: [model("z-ai/glm-5.2", "GLM-5.2 (via OpenRouter)", 1048576, 131072)] }),
      cloud("anthropic", "Anthropic", "https://api.anthropic.com", { tier: "popular", protocol: "anthropic" }),
      cloud("google", "Google", "https://generativelanguage.googleapis.com/v1beta/openai", { tier: "popular", protocol: "google" }),
      cloud("xai", "xAI", "https://api.x.ai/v1", { tier: "popular" }),
      cloud("groq", "Groq", "https://api.groq.com/openai/v1", { tier: "popular" }),
      cloud("mistral", "Mistral", "https://api.mistral.ai/v1", { tier: "popular" }),
      cloud("deepseek", "DeepSeek", "https://api.deepseek.com", { tier: "popular" }),
      // --- standard, dual protocol, aliases, retired model ---
      cloud("zai", "Z.ai", "https://api.z.ai/api/paas/v4", {
        protocols: [
          { protocol: "openai-compatible", api: "https://api.z.ai/api/paas/v4" },
          { protocol: "anthropic", api: "https://api.z.ai/api/anthropic" },
        ],
        aliases: ["z-ai", "zhipu"],
        resize_limits: { long_edge_px: 6000, max_bytes: 5242880 },
        models: [
          model("glm-5.2", "GLM-5.2", 1000000, 131072, { input_modalities: ["text", "image"] }),
          model("glm-4", "GLM-4", 0, 0, { status: "retired", tool_call: false }),
        ],
      }),
      // --- unsupported (US-8.AC2, §5 disposition table) ---
      unsupported("amazon-bedrock", "Amazon Bedrock", "cloud-iam"),
      unsupported("google-vertex", "Google Vertex AI", "cloud-iam"),
      unsupported("google-vertex-anthropic", "Google Vertex AI (Anthropic)", "cloud-iam"),
      unsupported("watsonx", "IBM watsonx", "cloud-iam"),
      unsupported("sap-ai-core", "SAP AI Core", "cloud-iam"),
      unsupported("azure", "Azure OpenAI", "deployment-url"),
      // --- local-file providers (US-2.AC4) ---
      cloud("ollama", "Ollama", "http://127.0.0.1:11434", { protocol: "ollama", env: "" }),
      cloud("vllm", "vLLM", "http://127.0.0.1:8000/v1", { env: "" }),
      cloud("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1", { env: "" }),
      cloud("litellm", "LiteLLM proxy", "https://litellm.example.invalid/v1"),
      cloud("codex-cli", "Codex CLI", "https://api.openai.com/v1", { protocol: "cli", cli_kind: "codex", auth_methods: ["sign_in"] }),
      cloud("openai-chatgpt", "ChatGPT (OpenAI account)", "https://api.openai.com/v1", { token_source: "codex-auth-json", auth_methods: ["sign_in"] }),
      cloud("github-copilot", "GitHub Copilot", "https://api.githubcopilot.com", { protocol: "cli", cli_kind: "copilot", auth_methods: ["sign_in"] }),
      cloud("shengsuanyun", "ShengSuanYun", "https://router.shengsuanyun.example.invalid/api/v1"),
      cloud("volcengine", "Volcengine", "https://ark.volcengine.example.invalid/api/v3"),
      cloud("avian", "Avian", "https://api.avian.example.invalid/v1"),
      cloud("mimo", "MiMo", "https://api.mimo.example.invalid/v1"),
    ],
  };
}

const byID = (doc, id) => doc.providers.find((p) => p.id === id);

// One mutation per check. Each returns the mutated document (or a raw string).
export const MUTATIONS = {
  JSON: () => "{ this is not json",
  SIZE: (d) => { d.source = "x".repeat(MAX_DOCUMENT_BYTES + 1); return d; },
  SCHEMA_VERSION: (d) => { d.schema_version = "1.0.0"; return d; },
  VERSION: (d) => { d.version = "2026.8.23"; return d; }, // DS-1.26: no leading v
  UPDATED_AT: (d) => { d.updated_at = "yesterday"; return d; },
  SOURCE: (d) => { d.source = ""; return d; },
  DEFAULT_RESIZE: (d) => { d.default_resize_limits.max_bytes = 0; return d; }, // DS-1.15
  PROVIDERS_MIN: (d) => { d.providers = []; return d; }, // DS-1.11 (also trips set checks; see test)
  PROVIDER_ID: (d) => { d.providers.push(structuredClone(byID(d, "zai"))); return d; }, // DS-1.5 duplicate zai
  PROVIDER_NAME: (d) => { byID(d, "zai").name = ""; return d; },
  TIER: (d) => { byID(d, "zai").tier = "gold"; return d; },
  UNSUPPORTED_REASON: (d) => { d.providers.push(unsupported("some-vanished-provider", "Vanished", "withdrawn")); delete d.providers.at(-1).unsupported_reason; return d; },
  PROTOCOL: (d) => { byID(d, "zai").protocol = "grpc"; byID(d, "zai").protocols[0].protocol = "grpc"; return d; }, // DS-1.7
  API_PRESENCE: (d) => { byID(d, "xai").api = ""; return d; },
  API_URL: (d) => { byID(d, "xai").api = "http://api.x.ai/v1"; return d; }, // DS-1.18 (scheme)
  PROTOCOLS_LIST: (d) => { byID(d, "zai").protocols.shift(); return d; }, // DS-1.23 lacks the primary
  AUTH_METHODS: (d) => { byID(d, "zai").auth_methods = []; return d; }, // DS-1.16
  CLI_KIND: (d) => { delete byID(d, "codex-cli").cli_kind; return d; },
  RESIZE_LIMITS: (d) => { byID(d, "zai").resize_limits.long_edge_px = 0; return d; },
  NO_CUSTOM: (d) => { byID(d, "litellm").custom = true; return d; },
  NEVER_PUBLISHED: (d) => { byID(d, "ollama").locality = "local"; return d; },
  MODEL_ID: (d) => { const z = byID(d, "zai"); z.models.push(structuredClone(z.models[0])); return d; }, // DS-1.6
  MODEL_SHAPE: (d) => { byID(d, "zai").models[0].status = "deprecated"; return d; },
  MODEL_TEXT: (d) => { byID(d, "zai").models[0].input_modalities = ["image"]; return d; }, // DS-1.8
  MODEL_LIMITS: (d) => { byID(d, "zai").models[0].context_window = 0; return d; }, // active model, unknown window
  ALIASES: (d) => { byID(d, "zai").aliases.push("openai"); return d; },
  POPULAR: (d) => { byID(d, "deepseek").tier = "standard"; return d; },
  CLOUD_IAM: (d) => { const p = byID(d, "amazon-bedrock"); p.tier = "standard"; delete p.unsupported_reason; p.protocol = "openai-compatible"; p.api = "https://bedrock.example.invalid/v1"; return d; },
  LOCAL_FILE_PROVIDERS: (d) => { d.providers = d.providers.filter((p) => p.id !== "mimo"); return d; },
};

export function generate(outDir = here) {
  const invalidDir = join(outDir, "invalid");
  rmSync(invalidDir, { recursive: true, force: true });
  mkdirSync(invalidDir, { recursive: true });
  writeFileSync(join(outDir, "valid-minimal.json"), JSON.stringify(validMinimal(), null, 2) + "\n");
  const missing = CHECKS.map((c) => c.id).filter((id) => !(id in MUTATIONS));
  if (missing.length) throw new Error(`no mutation for check(s): ${missing.join(", ")}`);
  for (const [id, mutate] of Object.entries(MUTATIONS)) {
    const out = mutate(validMinimal());
    const text = typeof out === "string" ? out : JSON.stringify(out, null, id === "SIZE" ? 0 : 2) + "\n";
    writeFileSync(join(invalidDir, `${id}.json`), text);
  }
  return Object.keys(MUTATIONS);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ids = generate();
  console.log(`wrote fixtures/valid-minimal.json and ${ids.length} fixtures/invalid/*.json`);
}
