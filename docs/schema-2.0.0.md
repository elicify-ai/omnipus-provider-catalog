# Catalog document schema 2.0.0

The shape of `providers_catalog.json`, copied from the Omnipus spec
(`docs/internal/specs/adr-067-registry-catalog-spec.md`, §5 "Integration
Boundaries", and ADR-067 §2/§8b). Where this file and the spec disagree, the spec
wins; fix this file.

Omnipus loads **only** `schema_version` `2.0.0`. Any other value is rejected and the
previously loaded document (or the embedded snapshot) is served. The old
`providers_capabilities.json` (schema 1.0.0) is not produced.

## Top level

| Field | Type | Rule | Source |
|---|---|---|---|
| `schema_version` | string | exactly `"2.0.0"` | job |
| `version` | string | monotonic, `vYYYY.M.D[.N]`, must match `^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$` — the leading `v` is required so Omnipus's comparator orders numerically (`v2026.9.30 < v2026.10.1`) | job (run date) |
| `updated_at` | string | RFC 3339, non-empty; Omnipus marks the catalog `stale` when older than 14 days | job |
| `source` | string | free text, non-empty; carries the upstream commit ids consumed | job (manifest) |
| `default_resize_limits` | object `{long_edge_px, max_bytes}` | both positive integers; used by Omnipus on a lookup miss | `resize_limits.json` (`default`) |
| `providers` | array of Provider | at least one; ids unique and non-empty | merge |

## Provider

| Field | Type | Rule | Source |
|---|---|---|---|
| `id` | string | models.dev provider id, or a local-providers-file id; non-empty, unique. Canonical ids are models.dev's (`zai`, `zhipuai`, `zai-coding-plan`, `moonshotai`, `alibaba-cn`, …). Custom rows are **never** in the document. | models.dev / local file |
| `name` | string | display name | models.dev / local file |
| `api` | string | base URL; empty only when `tier: unsupported`. Every non-empty value must be an absolute `https` URL with a host, no userinfo, no query, no fragment, host not an IP literal in loopback, link-local, RFC 1918, ULA or metadata ranges — except rows that are local (`protocol` `ollama`/`vllm`, id `lmstudio`), which may use `http` and local hosts. A violating document is rejected whole. | models.dev `api`; `overrides/` for the ~20 dedicated-SDK providers models.dev lists without a URL |
| `protocol` | string | primary wire protocol, one of `openai-compatible`, `anthropic`, `google`, `ollama`, `cli`; may be empty only when `tier: unsupported` | models.dev `npm` (mapped), `overrides/` may add |
| `protocols[]` | array of `{protocol, api}` | optional; when present must include the primary with the same `api`; entries unique. Used where a vendor serves a second protocol (Z.ai, Moonshot, DeepSeek also expose Anthropic-compatible endpoints). | `overrides/` |
| `env` | string | opaque; picker hint text only — Omnipus never reads keys from the environment | models.dev |
| `region` | string | optional (for example `us`, `cn`) | models.dev / `overrides/` |
| `plan` | string | optional (for example `coding-plan`) | models.dev / `overrides/` |
| `tier` | string | one of `popular`, `standard`, `unsupported`. The popular set is `{openai, openrouter, anthropic, google, xai, groq, mistral, deepseek}`. | `overrides/` only |
| `unsupported_reason` | string | required iff `tier: unsupported`; one of `cloud-iam` (`amazon-bedrock`, `google-vertex`, `google-vertex-anthropic`, `watsonx`, `sap-ai-core`), `deployment-url` (`azure`), `withdrawn` (vanished upstream, carried forward) | `overrides/` / job |
| `auth_methods[]` | array of string | non-empty subset of `{api_key, sign_in}` | `overrides/` / local file |
| `aliases[]` | array of string | search-only strings for the picker filter; never used for resolution, the factory, or config validation | `overrides/` |
| `company` | string | grouping key for the picker; defaults to `name` | `overrides/` |
| `cli_kind` | string | required iff `protocol: cli`; one of `codex`, `copilot` | local file |
| `token_source` | string | optional; `codex-auth-json` for `openai-chatgpt` | local file |
| `resize_limits` | object `{long_edge_px, max_bytes}` | positive integers; the provider's image upload limit, joined onto every model of the provider | `resize_limits.json` |
| `models` | array of Model | ids unique and non-empty within the provider | merge |

Not in the document: `locality` (`local`/`cloud`) is **derived by Omnipus on load**
and is never published; `subscription_policy` was dropped from the shape (X-11).

## Model

| Field | Type | Rule | Source |
|---|---|---|---|
| `id` | string | bare model id as the route serves it (`glm-5.2` under `zai`; `z-ai/glm-5.2` under `openrouter`); unique within the provider. Lookup in Omnipus is exact on `(provider, model)`, no prefix stripping. | models.dev |
| `name` | string | display name | models.dev |
| `release_date` | string | optional; `YYYY-MM-DD` | models.dev |
| `context_window` | integer | tokens; `0` = unknown. Limits are the **route's** (the aggregator's, not the vendor's). | models.dev `limit.context`, LiteLLM adjudicating, `overrides/` winning |
| `max_output_tokens` | integer | tokens; `0` = unknown | models.dev `limit.output`, LiteLLM adjudicating, `overrides/` winning |
| `input_modalities[]` | array of string | must include `text`; others such as `image`, `pdf`, `audio`, `video` | models.dev `modalities.input`, LiteLLM adjudicating, `overrides/` winning |
| `tool_call` | boolean | supports tool calling | models.dev |
| `status` | string | `active` or `retired` (vanished upstream, carried forward from the last published document) | models.dev / job |
| `disputed` | boolean | optional; `true` while a registry disagreement on this model is open as an issue and the last-known-good value is being published | job |

## Disagreement rule (applies per numeric field)

- Delta ≤ 5 % or ≤ 4,096 tokens, whichever is larger: not a dispute. Publish the
  **lower** value, record both in the manifest, open no issue.
- Larger delta, or any boolean/enum difference: publish the previously published
  value (last known good; models.dev's value when none exists), set `disputed: true`,
  open one issue. Never block the release, never silently adopt the newer number.
- Issue closed with an adjudicated value: write it to `overrides/`; it wins on the
  next run.

## Source summary

Everything comes from models.dev (with LiteLLM adjudicating and `overrides/`
winning) **except** `tier`, `unsupported_reason`, `auth_methods`, `aliases`,
`company`, `cli_kind`, `token_source`, which come only from `overrides/` or the
local-providers file; `resize_limits` and `default_resize_limits` come from
`resize_limits.json`; `locality` is derived by the consumer and never published.

## Minimal example

```json
{
  "schema_version": "2.0.0",
  "version": "v2026.8.23",
  "updated_at": "2026-08-23T06:00:00Z",
  "source": "models.dev@<commit> litellm@<commit> overrides@<commit>",
  "default_resize_limits": { "long_edge_px": 7680, "max_bytes": 10485760 },
  "providers": [
    {
      "id": "zai",
      "name": "Z.ai",
      "api": "https://api.z.ai/api/paas/v4",
      "protocol": "openai-compatible",
      "protocols": [
        { "protocol": "openai-compatible", "api": "https://api.z.ai/api/paas/v4" },
        { "protocol": "anthropic", "api": "https://api.z.ai/api/anthropic" }
      ],
      "env": "ZAI_API_KEY",
      "tier": "standard",
      "auth_methods": ["api_key"],
      "aliases": ["z-ai", "zhipu"],
      "company": "Z.ai",
      "resize_limits": { "long_edge_px": 6000, "max_bytes": 5242880 },
      "models": [
        {
          "id": "glm-5.2",
          "name": "GLM-5.2",
          "context_window": 1000000,
          "max_output_tokens": 131072,
          "input_modalities": ["text", "image"],
          "tool_call": true,
          "status": "active"
        }
      ]
    }
  ]
}
```

The URLs, numbers and aliases in the example are illustrative placeholders, not
verified registry values.
