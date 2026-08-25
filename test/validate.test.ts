import { describe, expect, it } from "vitest";

import type { Catalog, Provider } from "../src/schema.js";
import { LOCAL_FILE_PROVIDERS, POPULAR_SET } from "../src/schema.js";
import { MAX_DOCUMENT_BYTES, serialiseWithinCap, validateCatalog } from "../src/validate.js";

function provider(id: string, over: Partial<Provider> = {}): Provider {
  return {
    id,
    name: id,
    company: id,
    api: `https://api.${id}.example/v1`,
    protocol: "openai-compatible",
    env: [],
    tier: (POPULAR_SET as readonly string[]).includes(id) ? "popular" : "standard",
    auth_methods: ["api_key"],
    aliases: [],
    resize_limits: { long_edge_px: 8000, max_bytes: 1 },
    models: [{ id: "m1", name: "M1", tool_call: true, context_window: 1000, max_output_tokens: 100, input_modalities: ["text"], status: "active" }],
    ...over,
  };
}

function minimalCatalog(): Catalog {
  // Deduplicated: a provider may legitimately be in both lists — ollama is
  // popular AND sourced from overrides/local-providers.yaml. A naive concat
  // would build a duplicate id, which validateCatalog correctly rejects, so
  // the fixture would fail for a reason that has nothing to do with the case
  // under test.
  const providers = [...new Set<string>([...POPULAR_SET, ...LOCAL_FILE_PROVIDERS])].map((id) => provider(id));
  return {
    schema_version: "2.0.0",
    version: "v2026.8.23",
    updated_at: "2026-08-23T06:00:00Z",
    generated_at: "2026-08-23T06:00:00Z",
    source: "models.dev@abc litellm@def overrides@ghi",
    sources: {
      models_dev: { name: "models.dev", url: "u", license: "MIT", fetched_at: "t", commit: null, etag: null, sha256: "a".repeat(64), bytes: 1 },
      litellm: { name: "litellm", url: "u", license: "MIT", fetched_at: "t", commit: null, etag: null, sha256: "b".repeat(64), bytes: 1 },
      overrides_commit: null,
      previous_version: null,
    },
    default_resize_limits: { long_edge_px: 7680, max_bytes: 10485760 },
    providers,
  };
}

const messages = (c: unknown, opts = {}) => validateCatalog(c, opts).map((f) => `${f.path}: ${f.message}`);

// Index of a provider inside minimalCatalog(). Derived, never hardcoded: the
// fixture is built from POPULAR_SET + LOCAL_FILE_PROVIDERS, so any change to
// either list shifts positions. Assertions still pin the exact index and id
// the validator reports — they just compute the expected index the same way
// the fixture does.
const idxOf = (c: Catalog, id: string) => c.providers.findIndex((p) => p.id === id);

describe("validateCatalog", () => {
  it("accepts a conforming document", () => {
    expect(validateCatalog(minimalCatalog())).toEqual([]);
  });

  it("rejects any schema_version other than 2.0.0", () => {
    const c = { ...minimalCatalog(), schema_version: "1.0.0" };
    expect(messages(c).some((m) => m.startsWith("schema_version"))).toBe(true);
  });

  it("rejects a version without the leading v and a version not greater than the previous release", () => {
    expect(messages({ ...minimalCatalog(), version: "2026.8.23" }).some((m) => m.startsWith("version"))).toBe(true);
    expect(messages(minimalCatalog(), { previousVersion: "v2026.8.23" })).toEqual(["version: v2026.8.23 is not greater than the previous release v2026.8.23"]);
    expect(messages(minimalCatalog(), { previousVersion: "v2026.8.22.3" })).toEqual([]);
  });

  it("rejects duplicate provider ids and duplicate model ids within a provider, naming the path", () => {
    const c = minimalCatalog();
    c.providers.push(provider("openai"));
    const dup = messages(c);
    expect(dup.some((m) => m.includes('duplicate provider id "openai"'))).toBe(true);

    const c2 = minimalCatalog();
    c2.providers[0]!.models.push({ ...c2.providers[0]!.models[0]! });
    expect(messages(c2).some((m) => m.includes("duplicate model id"))).toBe(true);
  });

  it("accepts the same model id under two providers (the key is the pair)", () => {
    const c = minimalCatalog();
    expect(c.providers[0]!.models[0]!.id).toBe(c.providers[1]!.models[0]!.id);
    expect(validateCatalog(c)).toEqual([]);
  });

  it("requires every selectable cloud provider to have at least one model; local and unsupported rows may be empty", () => {
    const c = minimalCatalog();
    c.providers.find((p) => p.id === "mistral")!.models = [];
    expect(messages(c)).toEqual([`providers[${idxOf(c, "mistral")}](mistral).models: every selectable cloud provider needs at least one model`]);
    const c1 = minimalCatalog();
    const lite = c1.providers.find((p) => p.id === "litellm")!;
    lite.models = [];
    lite.tier = "unsupported";
    lite.unsupported_reason = "deployment-url";
    lite.api = "";
    expect(validateCatalog(c1)).toEqual([]);
    const c2 = minimalCatalog();
    const ollama = c2.providers.find((p) => p.id === "ollama")!;
    ollama.models = [];
    ollama.protocol = "ollama"; // local by protocol
    ollama.api = "http://localhost:11434/v1";
    expect(validateCatalog(c2)).toEqual([]);
  });

  it("api must be https on a public host for cloud rows; local rows may use http and loopback", () => {
    const bad = (api: string) => {
      const c = minimalCatalog();
      c.providers[0]!.api = api;
      return messages(c);
    };
    expect(bad("http://api.openai.example/v1")[0]).toContain("must be https");
    expect(bad("https://127.0.0.1/v1")[0]).toContain("loopback");
    expect(bad("https://10.1.2.3/v1")[0]).toContain("private");
    expect(bad("https://169.254.169.254/v1")[0]).toContain("metadata");
    expect(bad("https://user:pw@api.openai.example/v1")[0]).toContain("userinfo");
    expect(bad("https://api.openai.example/v1?x=1")[0]).toContain("query");
    expect(bad("https://api.openai.example/v1#f")[0]).toContain("fragment");
    expect(bad("not a url")[0]).toContain("not an absolute URL");

    const c = minimalCatalog();
    const vllm = c.providers.find((p) => p.id === "vllm")!; // local by id
    vllm.api = "http://localhost:8000/v1";
    expect(validateCatalog(c)).toEqual([]);
    const c2 = minimalCatalog();
    c2.providers.find((p) => p.id === "litellm")!.api = "http://localhost:4000/v1"; // not in the local-machine set
    expect(messages(c2)[0]).toContain("must be https");
  });

  it("empty api / empty protocol are allowed only on unsupported rows", () => {
    const c = minimalCatalog();
    c.providers[0]!.api = "";
    expect(messages(c)).toEqual(["providers[0](openai).api: may be empty only when tier is unsupported"]);
    const c2 = minimalCatalog();
    c2.providers[0]!.api = "";
    c2.providers[0]!.protocol = "";
    c2.providers[0]!.tier = "unsupported";
    expect(messages(c2)).toEqual(["providers[0](openai).unsupported_reason: required when tier is unsupported", "providers: popular provider openai is missing", "providers(openai).tier: must be popular"].slice(0, 1).concat(["providers(openai).tier: must be popular"]));
    const c3 = minimalCatalog();
    c3.providers.find((p) => p.id === "codex-cli")!.api = "";
    c3.providers.find((p) => p.id === "codex-cli")!.protocol = "cli";
    c3.providers.find((p) => p.id === "codex-cli")!.cli_kind = "codex";
    expect(messages(c3)).toEqual([`providers[${idxOf(c3, "codex-cli")}](codex-cli).api: may be empty only when tier is unsupported`]);
  });

  it("an alias must never equal a provider id (aliases are search-only)", () => {
    const c = minimalCatalog();
    c.providers.find((p) => p.id === "mimo")!.aliases = ["xiaomi-mimo", "openai"];
    expect(messages(c)).toEqual([`providers[${idxOf(c, "mimo")}](mimo).aliases[1]: alias "openai" collides with a provider id; aliases are search-only`]);
  });

  it("cli rows need cli_kind; non-cli rows must not carry it", () => {
    const c = minimalCatalog();
    c.providers[0]!.protocol = "cli";
    expect(messages(c)).toEqual(["providers[0](openai).cli_kind: required when protocol is cli"]);
    const c2 = minimalCatalog();
    c2.providers[0]!.cli_kind = "codex";
    expect(messages(c2)).toEqual(["providers[0](openai).cli_kind: only allowed when protocol is cli"]);
  });

  it("protocols[] must include the primary with the same api, and entries must be unique and valid URLs", () => {
    const c = minimalCatalog();
    c.providers[0]!.protocols = [{ protocol: "anthropic", api: "https://api.openai.example/anthropic" }];
    expect(messages(c)).toEqual(["providers[0](openai).protocols: must include the primary protocol with the same api"]);
    const c2 = minimalCatalog();
    c2.providers[0]!.protocols = [
      { protocol: "openai-compatible", api: c2.providers[0]!.api },
      { protocol: "openai-compatible", api: c2.providers[0]!.api },
    ];
    expect(messages(c2)).toEqual(["providers[0](openai).protocols[1]: duplicate protocols entry"]);
  });

  it("every model's input_modalities must include text; custom rows are rejected", () => {
    const c = minimalCatalog();
    c.providers[0]!.models[0]!.input_modalities = ["image"];
    expect(messages(c)).toEqual(["providers[0](openai).models[0](m1).input_modalities: must include text"]);
    const c2 = minimalCatalog();
    c2.providers[0]!.custom = true;
    expect(messages(c2)).toEqual(["providers[0](openai): custom rows are never in the document"]);
  });

  it("the popular set and the local-file providers must be present", () => {
    const c = minimalCatalog();
    c.providers = c.providers.filter((p) => p.id !== "xai" && p.id !== "vllm");
    expect(messages(c)).toEqual(["providers: popular provider xai is missing", "providers: local-file provider vllm is missing"]);
  });

  it("rejects unknown fields, unknown enum values and a document over 8 MB", () => {
    const c = minimalCatalog() as unknown as Record<string, unknown>;
    c.extra = 1;
    expect(messages(c)[0]).toContain("Unrecognized key");
    const c2 = minimalCatalog();
    (c2.providers[0] as unknown as { tier: string }).tier = "gold";
    expect(messages(c2)[0]).toMatch(/^providers\.0\.tier/);
    expect(messages(minimalCatalog(), { bytes: MAX_DOCUMENT_BYTES + 1 })).toEqual([`(root): document is ${MAX_DOCUMENT_BYTES + 1} bytes, over the ${MAX_DOCUMENT_BYTES} byte cap`]);
  });
});

describe("serialiseWithinCap", () => {
  it("returns the document unchanged when under the cap", () => {
    const { json, trimmed_retired } = serialiseWithinCap(minimalCatalog());
    expect(trimmed_retired).toBe(0);
    expect(JSON.parse(json).providers).toHaveLength(new Set<string>([...POPULAR_SET, ...LOCAL_FILE_PROVIDERS]).size);
  });

  it("drops status: retired models first when over the cap", () => {
    const c = minimalCatalog();
    const big = "x".repeat(250_000);
    for (const p of c.providers) {
      p.models.push({ id: "old", name: big, tool_call: false, context_window: 1, max_output_tokens: 1, input_modalities: ["text"], status: "retired" });
      p.models.push({ id: "old2", name: big, tool_call: false, context_window: 1, max_output_tokens: 1, input_modalities: ["text"], status: "retired" });
    }
    expect(Buffer.byteLength(JSON.stringify(c))).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    const { json, trimmed_retired } = serialiseWithinCap(c);
    expect(trimmed_retired).toBe(c.providers.length * 2);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(JSON.parse(json).providers.every((p: Provider) => p.models.every((m) => m.status === "active"))).toBe(true);
  });

  it("fails when still over the cap after trimming", () => {
    const c = minimalCatalog();
    c.providers[0]!.models[0]!.name = "x".repeat(MAX_DOCUMENT_BYTES + 10);
    expect(() => serialiseWithinCap(c)).toThrow(/even after trimming/);
  });
});
