# omnipus-provider-catalog

Daily-assembled LLM provider and model catalog for [Omnipus](https://omnipus.ai).

This repository is the **assembly repository** described in Omnipus ADR-067 (D1,
"the catalog is assembled from public registries by a daily job"). A scheduled job
pulls two public registries, merges them into one document keyed by
**provider + model**, applies local corrections, and publishes the result as a
GitHub Release. Omnipus fetches that release once a day (plus once at startup)
and falls back to an embedded snapshot when it cannot.

Status: **scaffold**. The workflow in `.github/workflows/assemble.yml` is a
skeleton of TODO steps; nothing is fetched or published yet.

## What is published

One release per assembly run, carrying exactly two assets:

| Asset | Content |
|---|---|
| `providers_catalog.json` | The catalog document, `schema_version` `2.0.0` (see `docs/schema-2.0.0.md`). |
| `providers_catalog.json.sha256` | Hex SHA-256 of the asset bytes: `<64 hex>` or `<64 hex>  providers_catalog.json`. |

The same two files are also reachable at the raw URL of `main`, which Omnipus uses
as a fallback when the Releases API is unreachable.

Publication rules (from the ADR and its spec):

- **Checksum only.** The sidecar is mandatory; Omnipus rejects a release without it.
  There is no release signature. A checksum proves integrity in transit, not
  authorship; the accepted risk and remaining mitigations are recorded in ADR-067 §2.
- **Version is `vYYYY.M.D[.N]`** with the leading `v` (for example `v2026.8.23`,
  `v2026.8.23.1` for a second run the same day). Omnipus never downgrades, so
  versions must only go up.
- **Last known good on disagreement.** When the two registries disagree on a field
  by more than the tolerance (5 % or 4,096 tokens, whichever is larger), the job
  publishes the previously published value (models.dev's when there is none), marks
  the model `disputed: true`, and opens an issue here. Within tolerance, the lower
  value is published with both recorded and no issue. A release is never blocked by a
  disagreement. A closed issue's adjudicated value is written into `overrides/`,
  which then wins.
- **Nothing is silently dropped.** A provider or model that vanishes upstream is
  carried forward from the last published document as `status: retired` (models) or
  `tier: unsupported`, `unsupported_reason: withdrawn` (providers).
- **The document must stay at or under 8 MB**, since Omnipus embeds it. If exceeded,
  `status: retired` models are trimmed first.

## Sources and licences

| Source | Used for | Licence |
|---|---|---|
| [models.dev](https://models.dev) `api.json` | Primary: provider identity (`id`, `api`, `npm` protocol, `env`), model limits (`limit.context`, `limit.output`), input modalities, tool calling, release dates | MIT |
| [LiteLLM](https://github.com/BerriAI/litellm) `model_prices_and_context_window.json` | Cross-check: adjudicates where models.dev and Omnipus's earlier hand-typed seed disagreed; flags disagreements | MIT |
| `overrides/` (this repo) | Hand-maintained corrections that win over both registries | MIT (this repo) |
| `resize_limits.json` (this repo) | Per-provider image upload limits, which neither registry carries | MIT (this repo) |
| Local-providers file (this repo, TODO) | Providers Omnipus ships that are absent from models.dev (`ollama`, `vllm`, `litellm`, `lmstudio`, `codex-cli`, `openai-chatgpt`, `github-copilot`, `shengsuanyun`, `volcengine`, `avian`, `mimo`) | MIT (this repo) |

Every run records the upstream commit ids it consumed in the document's `source`
field and in a manifest.

### What is NOT used, and why

- **OpenRouter's model list is not a generation source.** OpenRouter's terms of
  service forbid automated copying of Service data. Omnipus may query OpenRouter
  live, with the user's own key, for that user's session; this repository does not
  scrape or republish it. OpenRouter *as a provider* still appears in the catalog,
  because models.dev lists it with its own model table.
- **Hand-curation of the main table is not used.** The previous hand-typed seed was
  shown stale on 23 of 78 models when checked against both registries (ADR-067 §2).
  Hand edits live only in `overrides/`, are small, and are reviewed by pull request.

## Layout

```
README.md                        this file
LICENSE                          MIT
docs/schema-2.0.0.md             the document shape, every field and its source
overrides/README.md              how overrides work and what they may contain
validator/                       independent spec validator (npm run validate:spec -- <file>)
fixtures/                        minimal valid document + one invalid document per invariant
resize_limits.json               per-provider image upload limits
.github/workflows/assemble.yml   daily assembly job (skeleton)
```

## Consumer contract

The consumer side of this boundary is specified in the Omnipus repository:
`docs/internal/architecture/ADR-067-registry-fed-catalog-and-provider-identity.md`
and `docs/internal/specs/adr-067-registry-catalog-spec.md` (US-2, §5 "Integration
Boundaries", FR-001/002/007/009/026/027/032/033). A conformance fixture shared by
both sides lives in Omnipus under `pkg/providers/catalog/testdata/`; a copy will be
kept here for this repo's own tests.
