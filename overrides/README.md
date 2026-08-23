# overrides/

The catalog is merged from two public registries (models.dev and LiteLLM).
This directory holds the hand-maintained corrections and additions that are
applied on top of that merge. **Anything set here wins over both registries.**
It is the only place hand-typed provider or model data is allowed, and every
change lands by pull request.

## The three files

All three are YAML. They are applied after the registry merge, in this order:

1. `local-providers.yaml` — whole provider rows
2. `providers.yaml` — provider-level corrections
3. `models.yaml` — model-level corrections

Every row must carry a `reason`. Unknown keys are rejected. The exact
accepted fields are defined in `src/overrides.ts`.

### When to use which

| You want to… | File |
|---|---|
| Fix or add a provider field — a missing base URL, a second protocol, its tier, how it authenticates, search aliases | `providers.yaml` |
| Fix a model's limits, input types, tool-calling flag, name or date; settle a dispute; keep a model the registries have retired | `models.yaml` |
| Add a provider the registries do not list at all, or give an existing one a local/CLI row | `local-providers.yaml` |

### The `reason` line

Every row starts with `reason`, a short sentence saying why the value is
right: an issue number, a link to the provider's documentation, or the date
you checked it and how. A row without a reason fails to load, and a pull
request whose reason cannot be checked is not merged. This line is what lets
the next person tell a verified fact from a guess.

## `providers.yaml` — provider fields, keyed by provider id

```yaml
providers:
  groq:
    reason: "Base URL from https://console.groq.com/docs/openai, checked 2026-08-23."
    api: https://api.groq.com/openai/v1      # base URL
    protocol: openai-compatible              # openai-compatible | anthropic | google | ollama | cli
    protocols:                               # optional extra protocols; must include the primary
      - { protocol: openai-compatible, api: https://api.groq.com/openai/v1 }
    tier: popular                            # popular | standard | unsupported
    unsupported_reason: cloud-iam            # cloud-iam | deployment-url | withdrawn (only with tier: unsupported)
    auth_methods: [api_key, sign_in]         # non-empty subset of api_key | sign_in
    aliases: [g]                             # extra search strings
    company: Groq                            # grouping key (default: name)
    name: Groq                               # display-name correction
    env: [GROQ_API_KEY]                      # key variable names, hint only
    region: us                               # optional
    plan: coding-plan                        # optional
    cli_kind: codex                          # codex | copilot (only with protocol: cli)
    token_source: codex-auth-json            # optional
```

Every field except `reason` is optional; set only what you are correcting.
The provider must already exist in the merged document (from models.dev or
from `local-providers.yaml`); an override for an unknown id fails the run.

## `models.yaml` — model fields, keyed by provider id, then model id

```yaml
models:
  google:
    gemini-3-pro:
      reason: "Issue #42: registries disagree on PDF input; the API accepts PDFs, checked 2026-08-23."
      input_modalities: [text, image, audio, video, pdf]
      context_window: 1048576
      max_output_tokens: 65536
      tool_call: true
      status: active                         # active | retired
      name: Gemini 3 Pro
      release_date: 2025-11-18
```

Every field except `reason` is optional. Setting a field that is currently
disputed settles the dispute: the override value is published and the
`disputed` flag is cleared once no other field on that model is in dispute.

If the model id is not in the merged document, the row is created — this is
how a model the registries have retired is kept. A created row must carry
`context_window`, `max_output_tokens`, `input_modalities` and `tool_call`.

## `local-providers.yaml` — whole rows for providers the registries lack

Same fields as a provider override, but `name`, `api` and `protocol` are
required, and the row can carry a model list:

```yaml
providers:
  codex-cli:
    reason: "Command-line provider; models are the Codex family of the openai row."
    name: Codex CLI
    api: https://chatgpt.com/backend-api/codex
    protocol: cli
    cli_kind: codex
    auth_methods: [sign_in]
    models_from: openai                      # copy the models.dev openai row's models …
    model_ids: ["re:codex"]                  # … keeping only ids that match (exact string, or `re:` regex)
  avian:
    reason: "Not in models.dev. Base URL from https://avian.io docs, checked 2026-08-23."
    name: Avian
    api: https://api.avian.io/v1
    protocol: openai-compatible
    models:                                  # hand-typed rows (added after models_from)
      - { id: deepseek/deepseek-v4-pro, name: DeepSeek V4 Pro, tool_call: true, context_window: 1000000, max_output_tokens: 393216, input_modalities: [text] }
```

If the id already exists in models.dev (for example `lmstudio`), the row
**merges over** the registry row; its model list is kept unless `models_from`
or `models` is given.

Only the local-machine providers — `protocol: ollama`, or ids `vllm` and
`lmstudio` — may use `http://` or loopback URLs, and they may have no models
(consumers discover those live). Any other provider with only a loopback or
per-deployment URL (a self-hosted proxy such as `litellm`, for example) must be
published as `tier: unsupported`, `unsupported_reason: deployment-url`, with an
empty `api`.

## Worked example: correcting a context window

Suppose the catalog publishes `context_window: 128000` for `openai/gpt-5`,
but the vendor's documentation says 400,000.

1. Find the documentation page that states the value.
2. Add the row to `overrides/models.yaml`:

   ```yaml
   models:
     openai:
       gpt-5:
         reason: "https://platform.openai.com/docs/models/gpt-5 states a 400,000-token context window; checked 2026-08-23."
         context_window: 400000
   ```

3. Run `npm test` and `npm run assemble -- --offline` locally if you can; the
   loader will reject a malformed row, and `dist/manifest.json` will list the
   override under `overrides.models_applied`.
4. Open a pull request.

## How a change reaches a release

1. Your pull request is reviewed and merged to `main`.
2. The next daily run (06:00 UTC, or a manual run) loads `overrides/` from
   `main`, applies the three files after the registry merge, and records the
   commit id of `overrides/` in the document's `source` and `sources` fields.
3. If the result differs from the previous release, a new release
   `vYYYY.M.D[.N]` is published with your value in it.

One ordering detail: carry-forward of retired and withdrawn rows from the
previous release runs **after** overrides. A model that has vanished upstream
can therefore only be edited by `models.yaml` through a complete row (all four
required fields), which creates it fresh; carry-forward then leaves it alone.

## What belongs here

1. **Settled disagreements.** When the registries differ beyond tolerance, the
   daily run opens an issue. Once the right value is established, it is
   written here, citing the issue number.
2. **Registry gaps the provider contradicts in practice** — for example a model
   that accepts PDFs although the registries do not say so.
3. **Base URLs for providers with their own SDK.** models.dev records no URL
   for a number of providers that ship their own client library, but most are
   OpenAI-compatible on the wire. The URL goes here once it has been confirmed.
4. **Second protocols.** Where a vendor serves an Anthropic-compatible endpoint
   beside its OpenAI-compatible one, the extra `protocols` entry comes from
   here.
5. **Fields the registries do not carry at all:** `tier`, `unsupported_reason`,
   `auth_methods`, `aliases`, `company`, and `region` / `plan` corrections.
6. **Legacy models the registries have retired** that people still run.

## What does not belong here

- Anything copied from OpenRouter's model list (its terms of service do not
  permit it — see the README).
- Per-user or per-deployment settings; the catalog describes providers, not
  installations.
- Image upload limits: those live in `resize_limits.json` at the repository
  root, keyed by provider id.
- User-defined ("custom") provider rows: never in the published document.
