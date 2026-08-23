# overrides/

Local corrections that **win over both registries** (models.dev and LiteLLM). This
is the only place hand-typed data about a provider or model is allowed, and every
change lands by reviewed pull request.

## Format

Three YAML files, all applied after the registry merge, in this order:
`local-providers.yaml` → `providers.yaml` → `models.yaml`. Every row carries a
`reason` (required — the loader rejects a row without one). Unknown keys are
rejected. Schemas: `src/overrides.ts`.

### `providers.yaml` — provider fields, keyed by provider id

```yaml
providers:
  groq:
    reason: "Popular set (spec FR-018). OpenAI-compatible base fetch-verified 2026-08-23 https://console.groq.com/docs/openai"
    api: https://api.groq.com/openai/v1      # base URL (models.dev has none for dedicated-SDK providers)
    protocol: openai-compatible              # openai-compatible | anthropic | google | ollama | cli
    protocols:                               # optional second protocols; must include the primary
      - { protocol: openai-compatible, api: https://api.groq.com/openai/v1 }
    tier: popular                            # popular | standard | unsupported
    unsupported_reason: cloud-iam            # cloud-iam | deployment-url | withdrawn (only with tier: unsupported)
    auth_methods: [api_key, sign_in]         # non-empty subset of api_key | sign_in
    aliases: [g]                             # search-only strings for the picker filter
    company: Groq                            # grouping key (default: name)
    name: Groq                               # display-name correction
    env: [GROQ_API_KEY]                      # picker hint only
    region: us                               # optional
    plan: coding-plan                        # optional
    cli_kind: codex                          # codex | copilot (only with protocol: cli)
    token_source: codex-auth-json            # optional
```

The provider must exist in the merged document (models.dev or
`local-providers.yaml`); an override for an unknown id fails the run.

### `models.yaml` — model fields, keyed by provider id → model id

```yaml
models:
  google:
    gemini-3-pro:
      reason: "Issue #NN: registries disagree on PDF input; the API accepts PDFs (probe 2026-08-23)"
      input_modalities: [text, image, audio, video, pdf]
      context_window: 1048576
      max_output_tokens: 65536
      tool_call: true
      status: active                         # active | retired
      name: Gemini 3 Pro
      release_date: 2025-11-18
```

Setting a field that is currently disputed resolves that dispute (override-sourced
values never raise an issue). A model id that is not in the merged document is
created — a legacy model the registries retired — and then must carry
`context_window`, `max_output_tokens`, `input_modalities` and `tool_call`.

### `local-providers.yaml` — whole rows for providers absent from models.dev

Same fields as a provider override plus `name`, `api` and `protocol` (required),
and a model list:

```yaml
providers:
  codex-cli:
    reason: "..."
    name: Codex CLI
    api: ""                                  # cli rows have no HTTP endpoint
    protocol: cli
    cli_kind: codex
    auth_methods: [sign_in]
    models_from: openai                      # copy the models.dev openai row's models …
    model_ids: ["re:codex"]                  # … keeping ids that match (exact string, or `re:` regex)
  avian:
    reason: "..."
    name: Avian
    api: https://api.avian.io/v1
    protocol: openai-compatible
    models:                                  # hand-typed rows (appended after models_from)
      - { id: deepseek/deepseek-v4-pro, name: DeepSeek V4 Pro, tool_call: true, context_window: 1000000, max_output_tokens: 393216, input_modalities: [text] }
```

If the id already exists in models.dev (`lmstudio`, `github-copilot`), the row
**merges over** the registry row (its model list is kept unless `models_from` /
`models` is given). Local rows (`protocol: ollama`, ids `vllm` / `lmstudio` — the
spec's FR-039 set, nothing else) may use `http` / loopback URLs and may have no
models, since Omnipus lists them live (spec FR-020). Any other row with a
loopback URL (e.g. `litellm`) must be published `unsupported / deployment-url`
with an empty `api`; operators reach such proxies through a custom row.

### Ordering note

Carry-forward (retired / withdrawn rows from the previous release) runs **after**
overrides, so a local-file provider is never mistaken for one that vanished. A
consequence: a model that vanished upstream and is being carried forward cannot
be edited by `models.yaml` unless the override row is complete (it is then
created fresh, and carry-forward leaves it alone).

## What belongs here

1. **Adjudicated disagreements.** When the two registries differ beyond tolerance,
   the job publishes last-known-good and opens an issue. The closed issue's
   adjudicated value is written here, citing the issue number.
2. **Registry gaps the provider contradicts in practice.** Example from ADR-067:
   `gemini-3-pro` PDF input, where the registries disagree and the provider accepts
   PDFs in practice.
3. **Base URLs for dedicated-SDK providers.** models.dev records no `api` for ~26
   providers that ship their own SDK (groq, mistral, xai, deepseek, cerebras,
   togetherai, deepinfra, perplexity, openrouter, cohere, …) but most are
   OpenAI-compatible on the wire. Each URL row is added only once the Omnipus probe
   has confirmed the endpoint works.
4. **Second protocols.** Where a vendor serves an Anthropic-compatible endpoint
   beside its OpenAI-compatible one (Z.ai, Moonshot, DeepSeek), the extra
   `protocols[]` entry comes from here. The registry is the default, not the ceiling.
5. **Fields the registries do not carry at all**, which are authored only here or in
   the local-providers file: `tier` (and the popular set
   `{openai, openrouter, anthropic, google, xai, groq, mistral, deepseek}`),
   `unsupported_reason` (`cloud-iam`, `deployment-url`), `auth_methods[]`, `aliases[]`
   (search-only), `company`, `region`/`plan` corrections.
6. **Legacy models the registries have retired** that Omnipus users still run.

## What does not belong here

- Anything copied from OpenRouter's model list (terms of service; see the README).
- Per-user context window overrides: those are Omnipus-side settings
  (ADR-066 `ContextSettings.model_overrides[]`), never catalog data.
- `resize_limits`: those live in `resize_limits.json` at the repo root, per provider.
- Custom (operator-named) provider rows: never in the published document.

## Review rule

Every row carries a reason: an issue number, a documentation link, or a dated
probe result. An override with no reason is rejected in review.
