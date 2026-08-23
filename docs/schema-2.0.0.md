# Catalog document schema 2.0.0

This is the field-by-field reference for `providers_catalog.json`. It matches
the validation schema in `src/schema.ts`; if you find a difference, the code is
right.

Every object is **closed**: a document with a field not listed here is
rejected. Fields marked *optional* may be absent; all others are always
present.

The "Source" column says where a value comes from:

- **job** — computed by the daily assembly run itself;
- **models.dev** — the primary registry;
- **LiteLLM** — the cross-check registry (used to confirm, fill in, or dispute
  a models.dev value);
- **overrides** — the hand-maintained files in `overrides/`, which win over
  both registries;
- **resize_limits.json** — the per-provider image limits file in this
  repository.

## Top level

| Field | Type | Meaning and allowed values | Source |
|---|---|---|---|
| `schema_version` | string | The shape of this document. Always exactly `"2.0.0"`. | job |
| `version` | string | The release version, `vYYYY.M.D` with an optional `.N` counter for a second run on the same day (`v2026.8.23`, `v2026.8.23.1`). Must match `^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$`. Versions only go up. | job (run date) |
| `updated_at` | string | When the document was assembled, as an RFC 3339 timestamp (`2026-08-23T06:00:00Z`). | job |
| `generated_at` | string | Same value as `updated_at`. | job |
| `source` | string | One line naming the upstream snapshots used: `models.dev@<commit> litellm@<commit> overrides@<commit>`. | job |
| `sources` | object | The same information in structured form — see [Sources](#sources). | job |
| `default_resize_limits` | object | Image upload limit to assume for a provider with no entry of its own — see [Resize limits](#resize-limits). | resize_limits.json (`default`) |
| `providers` | array of [Provider](#provider) | At least one. Provider ids are unique. | merge |

## Sources

The `sources` object records exactly what the run consumed.

| Field | Type | Meaning and allowed values | Source |
|---|---|---|---|
| `models_dev` | [SourceRecord](#sourcerecord) | The models.dev snapshot. | job |
| `litellm` | [SourceRecord](#sourcerecord) | The LiteLLM snapshot. | job |
| `overrides_commit` | string or null | Git commit of this repository's `overrides/` and `resize_limits.json` at assembly time; `null` when the run was not inside a git checkout. | job |
| `previous_version` | string or null | The `version` of the previous release the run compared against; `null` on a first release or a deliberate reset. | job |

### SourceRecord

| Field | Type | Meaning and allowed values | Source |
|---|---|---|---|
| `name` | string | `models.dev` or `litellm`. | job |
| `url` | string | The URL the file was fetched from. | job |
| `license` | string | The source's licence (`MIT` for both). | job |
| `fetched_at` | string | When it was fetched (RFC 3339). | job |
| `commit` | string or null | The upstream git commit id of that file, when it could be determined. | job |
| `etag` | string or null | The HTTP ETag the server returned, if any. | job |
| `sha256` | string | SHA-256 of the fetched bytes, 64 lowercase hex characters. | job |
| `bytes` | integer | Size of the fetched file in bytes. | job |

## Provider

| Field | Type | Meaning and allowed values | Source |
|---|---|---|---|
| `id` | string | Stable identifier, unique across the document (`openai`, `zai`, `moonshotai`, `alibaba-cn`, …). Ids follow models.dev's naming; providers added locally use their own id. | models.dev / overrides |
| `name` | string | Display name. | models.dev / overrides |
| `company` | string | The company behind the provider, used to group providers that belong together. Defaults to `name`. | overrides (default: `name`) |
| `api` | string | Base URL to send requests to. Empty only when `tier` is `unsupported`. Otherwise an absolute `https` URL with a public host — no credentials, query or fragment, and no private, loopback or link-local IP address. Local-machine providers (`ollama`, `vllm`, `lmstudio`) are the exception and may use `http://localhost…`. | models.dev; overrides for providers models.dev lists without a URL |
| `protocol` | string | The wire protocol to speak to `api`: `openai-compatible`, `anthropic`, `google`, `ollama` or `cli`. Empty string only when `tier` is `unsupported`. | models.dev (mapped from its SDK package name) / overrides |
| `protocols` | array of [ProtocolEntry](#protocolentry), *optional* | Every protocol-and-URL pair the provider serves, when it serves more than one (for example an OpenAI-compatible and an Anthropic-compatible endpoint side by side). When present it includes the primary `protocol` with the same `api`; entries are unique. | overrides |
| `env` | array of string | Environment variable names conventionally used for this provider's key (`["OPENAI_API_KEY"]`). A hint for labels only; may be empty. | models.dev / overrides |
| `region` | string, *optional* | Region hint such as `us` or `cn`. | models.dev / overrides |
| `plan` | string, *optional* | Plan hint such as `coding-plan`. | models.dev / overrides |
| `tier` | string | `popular`, `standard` or `unsupported`. The popular set is fixed: `openai`, `anthropic`, `openrouter`, `google`, `xai`, `groq`, `mistral`, `deepseek`. Defaults to `standard`. | overrides / job |
| `unsupported_reason` | string, *optional* | Present exactly when `tier` is `unsupported`. `cloud-iam` — the provider needs a cloud identity sign-in (AWS, GCP, IBM, SAP) rather than an API key; `deployment-url` — every deployment has its own URL, so there is no single endpoint to publish; `withdrawn` — the provider vanished from the sources and is carried forward from the previous release. | overrides / job |
| `auth_methods` | array of string | How you authenticate: any non-empty subset of `api_key`, `sign_in`. Defaults to `["api_key"]`. | overrides (default: `api_key`) |
| `aliases` | array of string | Extra search strings for a picker (`claude` for `anthropic`). Never used for lookup; may be empty. | overrides |
| `custom` | boolean, *optional* | Reserved for user-defined provider rows in consuming applications. Never `true` in a published document; the validator rejects it. | — |
| `cli_kind` | string, *optional* | Present exactly when `protocol` is `cli`: which command-line tool drives the provider, `codex` or `copilot`. | overrides |
| `token_source` | string, *optional* | Where a signed-in provider's token is read from (for example `codex-auth-json`). | overrides |
| `resize_limits` | [ResizeLimits](#resize-limits) | The largest image this provider accepts; applies to every model of the provider. Falls back to `default_resize_limits` when the provider has no entry. | resize_limits.json |
| `models` | array of [Model](#model) | The provider's models. Ids are unique within the provider. May be empty for local-machine providers, whose models are discovered live. | merge |

### ProtocolEntry

| Field | Type | Meaning and allowed values | Source |
|---|---|---|---|
| `protocol` | string | One of `openai-compatible`, `anthropic`, `google`, `ollama`, `cli`. | overrides |
| `api` | string | The base URL for that protocol. Same URL rules as the provider's `api`. | overrides |

### Resize limits

Used for both `default_resize_limits` and a provider's `resize_limits`.

| Field | Type | Meaning and allowed values | Source |
|---|---|---|---|
| `long_edge_px` | integer | Longest image edge accepted, in pixels. Positive. | resize_limits.json |
| `max_bytes` | integer | Largest image file accepted, in bytes. Positive. | resize_limits.json |

## Model

| Field | Type | Meaning and allowed values | Source |
|---|---|---|---|
| `id` | string | The model id exactly as this provider's API expects it (`glm-5.2` under `zai`, `z-ai/glm-5.2` under `openrouter`). Unique within the provider. | models.dev |
| `name` | string | Display name. | models.dev / overrides |
| `release_date` | string, *optional* | Release date, `YYYY-MM-DD`. | models.dev / overrides |
| `tool_call` | boolean | Whether the model supports tool calling (function calling). | models.dev, LiteLLM cross-check, overrides win |
| `context_window` | integer | How much text the model can take in at once — prompt and reply together — in tokens. `0` means unknown. These are the limits of the route you call (an aggregator's limit may differ from the original vendor's). | models.dev, LiteLLM cross-check or fill, overrides win |
| `max_output_tokens` | integer | The longest reply the model can produce, in tokens. `0` means unknown. | models.dev, LiteLLM cross-check or fill, overrides win |
| `input_modalities` | array of string | What the model accepts as input. Always includes `text`; may add `image`, `audio`, `video`, `pdf`. No other values. | models.dev, LiteLLM cross-check, overrides win |
| `status` | string | `active`, or `retired` when the model has vanished from the sources and is carried forward from the previous release. | models.dev / job |
| `disputed` | boolean, *optional* | Present and `true` while the two registries disagree about this model beyond tolerance and the previous release's value is being published. Absent otherwise. | job |

Active models always have `context_window` greater than `0`; a model for which
no source knows the window is held back until one does.

## How disagreements are resolved

For each numeric field the two registries are compared:

- Difference within 5 % or 4,096 tokens, whichever is larger: the **lower**
  value is published. Not a dispute.
- Larger difference, or any explicit disagreement on `tool_call` or an input
  type: the previous release's value is published (models.dev's when there is
  none), `disputed` is set to `true`, and a GitHub issue lists the row. A
  release is never blocked.
- models.dev reports `0` and LiteLLM has a value: LiteLLM's value fills the
  gap. Not a dispute.
- A value set in `overrides/` wins outright and clears the dispute on that
  field.

## Minimal example

```json
{
  "schema_version": "2.0.0",
  "version": "v2026.8.23",
  "updated_at": "2026-08-23T06:00:00Z",
  "generated_at": "2026-08-23T06:00:00Z",
  "source": "models.dev@<commit> litellm@<commit> overrides@<commit>",
  "sources": {
    "models_dev": {
      "name": "models.dev",
      "url": "https://models.dev/api.json",
      "license": "MIT",
      "fetched_at": "2026-08-23T06:00:00Z",
      "commit": "<commit>",
      "etag": null,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 0
    },
    "litellm": {
      "name": "litellm",
      "url": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      "license": "MIT",
      "fetched_at": "2026-08-23T06:00:00Z",
      "commit": "<commit>",
      "etag": null,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 0
    },
    "overrides_commit": "<commit>",
    "previous_version": null
  },
  "default_resize_limits": { "long_edge_px": 7680, "max_bytes": 10485760 },
  "providers": [
    {
      "id": "zai",
      "name": "Z.ai",
      "company": "Z.ai",
      "api": "https://api.z.ai/api/paas/v4",
      "protocol": "openai-compatible",
      "protocols": [
        { "protocol": "openai-compatible", "api": "https://api.z.ai/api/paas/v4" },
        { "protocol": "anthropic", "api": "https://api.z.ai/api/anthropic" }
      ],
      "env": ["ZAI_API_KEY"],
      "tier": "standard",
      "auth_methods": ["api_key"],
      "aliases": ["z-ai", "zhipu"],
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

The URLs, numbers and aliases in the example are placeholders that satisfy the
shape rules, not verified registry values.
