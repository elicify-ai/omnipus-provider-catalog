# overrides/

Local corrections that **win over both registries** (models.dev and LiteLLM). This
is the only place hand-typed data about a provider or model is allowed, and every
change lands by reviewed pull request.

Nothing lives here yet; the file format is decided when the assembly job is written
(TODO). Whatever the format, an override is always keyed by `(provider id, model id)`
for model fields or by `provider id` for provider fields, and the job applies it
after the registry merge.

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
