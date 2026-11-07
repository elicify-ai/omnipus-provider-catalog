// Publication oracle: WU-24 (founder 2026-10-14) removes subprocess model
// providers, not the HTTP ChatGPT provider. Legacy documents still load so
// carry-forward must not resurrect the removed rows or mechanism metadata.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assemble } from "../src/assemble.js";
import { cacheFetched, sha256Hex } from "../src/fetch.js";
import type { Catalog, Provider, SourceRecord } from "../src/schema.js";
import type { ModelsDevApi } from "../src/sources.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resize = { long_edge_px: 7680, max_bytes: 10485760 };
// The pinned popular set is part of the publication contract, not read from
// the implementation's required-provider constants.
const popular = ["openai", "anthropic", "google", "openrouter", "deepseek", "zai", "minimax", "moonshotai", "alibaba", "xai", "mistral", "ollama"];
// Synthetic prices exercise conservation, including a real zero and every
// optional cache field. They are inputs, not observed assembler output.
const cost = {
  input: 1,
  output: 5,
  reasoning: 3,
  cache_read: 0.1,
  cache_write: 0,
  cache_write_1h: 2,
  tiers: [{ input: 2, output: 10, cache_read: 0.2, cache_write: 0, cache_write_1h: 4, tier: { type: "context" as const, size: 200000, boundary: "above" as const } }],
  context_over_200k: { input: 2, output: 10, cache_read: 0.2, cache_write: 0, cache_write_1h: 4 },
};
const model = { id: "gpt-codex", name: "Synthetic model", tool_call: true, context_window: 200000, max_output_tokens: 8192, input_modalities: ["text"] as ["text"], status: "active" as const, cost };

function sourceRecord(name: string, bytes: Uint8Array): SourceRecord {
  return { name, url: `https://${name}.example/fixture.json`, license: "MIT", fetched_at: "2026-10-15T06:00:00Z", commit: null, etag: null, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
}

function legacyProvider(id: string, fields: Partial<Provider> = {}): Provider {
  return { id, name: id, company: id, api: `https://${id}.example/v1`, protocol: "openai-compatible", env: [], tier: "standard", auth_methods: ["sign_in"], aliases: [], resize_limits: resize, models: [structuredClone(model)], ...fields };
}

function previous(providers: Provider[]): Catalog {
  const bytes = new Uint8Array();
  return { schema_version: "2.0.0", version: "v2026.10.14", updated_at: "2026-10-14T06:00:00Z", generated_at: "2026-10-14T06:00:00Z", source: "synthetic previous release", sources: { models_dev: sourceRecord("models.dev", bytes), litellm: sourceRecord("litellm", bytes), overrides_commit: null, previous_version: null }, default_resize_limits: resize, providers };
}

async function assembleOffline(opts: { upstreamRetired?: boolean; previous?: Catalog } = {}) {
  const cacheRoot = path.join(repoRoot, ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const root = await mkdtemp(path.join(cacheRoot, "retirement-test-"));
  try {
    const overridesDir = path.join(root, "overrides");
    const cacheDir = path.join(root, "cache");
    const outDir = path.join(root, "dist");
    await mkdir(overridesDir);
    // Keep the real local-provider definitions in the test: a stale definition
    // must fail this regression, not hide behind a hand-written replacement.
    await copyFile(path.join(repoRoot, "overrides", "local-providers.yaml"), path.join(overridesDir, "local-providers.yaml"));
    await writeFile(path.join(overridesDir, "providers.yaml"), JSON.stringify({ providers: Object.fromEntries(popular.map((id) => [id, { reason: "fixture popular-tier contract", tier: "popular" }])) }));
    await writeFile(path.join(root, "resize_limits.json"), JSON.stringify({ default: resize, providers: {} }));
    const ids = [...popular.filter((id) => id !== "ollama"), "xiaomi", "github-copilot", ...(opts.upstreamRetired ? ["codex-cli"] : [])];
    const md: ModelsDevApi = Object.fromEntries(ids.map((id) => [id, { id, name: id, npm: "@ai-sdk/openai-compatible", api: `https://${id}.example/v1`, models: { [model.id]: { id: model.id, name: model.name, tool_call: true, limit: { context: model.context_window, output: model.max_output_tokens }, modalities: { input: ["text"] }, cost: structuredClone(cost) } } }]));
    for (const [name, json] of [["models.dev", md], ["litellm", {}]] as const) {
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(json)));
      await cacheFetched(cacheDir, name, { json, bytes, record: sourceRecord(name, bytes) });
    }
    const prevFile = opts.previous ? path.join(root, "previous.json") : null;
    if (prevFile) await writeFile(prevFile, JSON.stringify(opts.previous));
    const result = await assemble({ repoRoot: root, cacheDir, outDir, offline: true, previous: prevFile, now: new Date("2026-10-15T06:00:00Z") });
    return { ...result, published: await readFile(path.join(outDir, "providers_catalog.json"), "utf8") };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectNoRetiredSurface(json: string) {
  const catalog = JSON.parse(json) as Catalog;
  expect(catalog.providers.filter((p) => ["codex-cli", "github-copilot"].includes(p.id)).map((p) => p.id)).toEqual([]);
  expect(catalog.providers.filter((p) => p.protocol === "cli").map((p) => p.id)).toEqual([]);
  expect(catalog.providers.flatMap((p) => (p.protocols ?? []).filter((e) => e.protocol === "cli").map(() => p.id))).toEqual([]);
  expect(json).not.toMatch(/"(?:cli_kind|token_source)"\s*:/i);
}

describe("WU-24 catalog publication", () => {
  it("does not publish retired IDs from registries or the real local overrides", async () => {
    // HTTP registry rows ensure an ID ban cannot be replaced by a CLI-only ban.
    const result = await assembleOffline({ upstreamRetired: true });
    expect(result.published).toBe(result.json);
    expectNoRetiredSurface(result.published);
  });

  it("does not carry forward retired IDs or a subprocess provider under a new ID", async () => {
    const result = await assembleOffline({ previous: previous([
      legacyProvider("codex-cli"),
      legacyProvider("github-copilot"),
      legacyProvider("renamed-subprocess", { protocol: "cli", cli_kind: "codex" }),
    ]) });
    expectNoRetiredSurface(result.published);
    expect(result.catalog.providers.filter((p) => p.id === "renamed-subprocess")).toEqual([]);
  });

  it("keeps HTTP ChatGPT, ordinary carry-forward and every cost field without retired mechanism metadata", async () => {
    const result = await assembleOffline({ previous: previous([
      legacyProvider("legacy-http", { cli_kind: "codex", token_source: "codex-auth-json", protocols: [
        { protocol: "openai-compatible", api: "https://legacy-http.example/v1" },
        { protocol: "cli", api: "https://legacy-http.example/v1" },
      ] }),
    ]) });
    expectNoRetiredSurface(result.published);
    const chatgpt = result.catalog.providers.find((p) => p.id === "openai-chatgpt")!;
    expect(chatgpt).toMatchObject({ protocol: "openai-compatible", auth_methods: ["sign_in"] });
    expect(chatgpt.models).toHaveLength(1);
    expect(chatgpt.models[0]!.cost).toEqual(cost);
    const carried = result.catalog.providers.find((p) => p.id === "legacy-http")!;
    expect(carried).toMatchObject({ protocol: "openai-compatible", tier: "unsupported", unsupported_reason: "withdrawn", auth_methods: ["sign_in"] });
    expect(carried.protocols).toEqual([{ protocol: "openai-compatible", api: "https://legacy-http.example/v1" }]);
    expect(carried.models).toEqual([{ ...model, status: "retired" }]);
  });

  it("keeps the checked-in downloadable catalog free of retired rows and fields", async () => {
    expectNoRetiredSurface(await readFile(path.join(repoRoot, "providers_catalog.json"), "utf8"));
  });
});
