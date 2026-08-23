# omnipus-provider-catalog

Daily-assembled LLM provider and model catalog for [Omnipus](https://omnipus.ai).

This repository is the **assembly repository** described in Omnipus ADR-067 (D1,
"the catalog is assembled from public registries by a daily job"). A scheduled job
pulls two public registries, merges them into one document keyed by
**provider + model**, applies local corrections, and publishes the result as a
GitHub Release. Omnipus fetches that release once a day (plus once at startup)
and falls back to an embedded snapshot when it cannot.

Status: **assembler implemented, publishing not yet wired.** `npm run assemble`
fetches both registries, merges, applies `overrides/`, validates and writes
`dist/providers_catalog.json` + `.sha256`. The workflow in
`.github/workflows/assemble.yml` runs that; the release / raw-copy / snapshot-PR
steps (7–8) are still TODO comments — no release is published yet.

## How to run

Requires Node 22+ (`package.json` `engines`). Everything is TypeScript run with
`tsx`; there is no build step.

```bash
npm ci
npm run fetch       # optional: pull both registries into .cache/ (records sha256, ETag, upstream commit)
npm run assemble    # fetch (or `-- --offline` to reuse .cache/), merge, override, validate → dist/
npm run validate    # re-validate dist/providers_catalog.json (or `-- <file>`)
npm run validate:spec -- dist/providers_catalog.json   # independent spec checker (validator/), written separately from the assembler
npm test            # vitest: merge rule, tolerance, carry-forward, overrides, validator, version
npm run typecheck
```

`npm run assemble` flags (pass after `--`):

| Flag | Meaning |
|---|---|
| `--offline` | use `.cache/models.dev.json` and `.cache/litellm.json` from the last `fetch`/`assemble` instead of fetching |
| `--previous <file>` | the last published document (last known good). Default: `dist/providers_catalog.json` if present, else `providers_catalog.json` at the repo root, else none |
| `--no-previous` | ignore any previous document (first release, or a deliberate reset) |
| `--out <dir>` | output directory (default `dist/`) |
| `--date YYYY-MM-DD` | run date for the version (default: now, UTC) |

Outputs in `dist/` (gitignored — the publish step copies them where they are served):

| File | Content |
|---|---|
| `providers_catalog.json` | the 2.0.0 document |
| `providers_catalog.json.sha256` | `<64 hex>  providers_catalog.json` |
| `manifest.json` | what the run consumed and decided: source records (sha256, ETag, upstream commit, bytes), counts, every dispute (for the publish step to open issues), every within-tolerance pick, LiteLLM fills, carry-forwards, overrides applied, rows auto-marked unsupported, models.dev rows skipped (no `text` input modality) |

Exit codes: `0` ok · `2` validation findings (each printed as `path: message`) · `1` any other error.

### What a run does, in order

1. **Fetch** models.dev `api.json` and LiteLLM's JSON (`src/fetch.ts`); record sha256, byte count, ETag and the upstream commit id (GitHub API; `null` when unavailable) for each.
2. **Normalise** models.dev (`src/sources.ts`): map `npm` to an Omnipus protocol, drop `${VAR}` template URLs, keep only models whose input modalities include `text`.
3. **Merge** (`src/merge.ts`): models.dev is primary; for every model with a LiteLLM row on the same route, cross-check `context_window`, `max_output_tokens`, `tool_call` and modalities with the disagreement rule below.
4. **Overrides** (`src/overrides.ts`): add local-provider rows, then provider overrides, then model overrides — see `overrides/README.md`.
5. **Carry forward** (`src/carry.ts`) from the previous document: vanished models → `status: retired`; vanished providers → `tier: unsupported`, `unsupported_reason: withdrawn`.
6. **Finalise** (`src/finalize.ts`): defaults (`company` = `name`, `tier: standard`, `auth_methods: [api_key]`), join `resize_limits.json`, auto-mark rows with no usable protocol, no URL, or a non-https/private-host URL (outside the spec's local set `ollama` / `vllm` / `lmstudio`) as `unsupported / deployment-url`. `locality` is never published — Omnipus derives it.
7. **Validate** (`src/validate.ts`) and write; trim `status: retired` models first if over 8 MB.

### Disagreement rule (as implemented)

Per numeric field, with `a` = models.dev and `b` = LiteLLM:

- `a == b`: agree.
- `|a − b| ≤ max(4096, 5 % × max(a, b))`: **within tolerance** — publish `min(a, b)`, record both in `manifest.json`, no dispute.
- larger: **dispute** — publish the previous release's value when it exists and is non-zero, else models.dev's; set `disputed: true` on the model; record it in `manifest.disputes[]` with both values and the LiteLLM key. The publish step (TODO) opens the issue; the release is never blocked.
- `a == 0` (models.dev does not know) and LiteLLM has a value: **fill** from LiteLLM, recorded, not a dispute.
- `tool_call` and each modality LiteLLM explicitly states (`supported_modalities`, `supports_vision`, `supports_audio_input`, `supports_pdf_input`): a difference is a dispute with the same last-known-good rule. Modalities LiteLLM is silent on are never disputed.
- A value set in `overrides/models.yaml` resolves the dispute on that field; `disputed` is cleared when no dispute on the model remains.

Only models with a sound route correspondence are cross-checked (`LITELLM_PROVIDER_MAP` in `src/sources.ts`, ~35 providers). A provider absent from the map is simply published as models.dev states it.

## Release rule

- `version` is `vYYYY.M.D` from the run's UTC date; a second run on the same day
  (or a clock behind the last publisher) bumps `.N`. The validator rejects a
  version not strictly greater than `--previous`. Omnipus never downgrades.
- `updated_at` / `generated_at` is the run time; `source` is
  `models.dev@<commit> litellm@<commit> overrides@<this repo's HEAD>` and the
  structured `sources` block carries the full records.
- The document must validate with zero findings (see `src/validate.ts`: schema,
  unique ids, ≥1 model per selectable cloud provider, https + public host for every cloud
  `api`, every `unsupported` row has a reason, popular set and the 11 local-file
  providers present, no `custom` row, ≤ 8 MB).
- The checksum sidecar is mandatory and is written with the document.
- A dispute never blocks a release; a vanished row never disappears.

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
- **Only text-generating models with a known window are published.** models.dev rows
  whose output modalities exclude `text` (image, video and speech generators) are not
  chat models and are skipped; a text model for which neither registry carries a
  context window is held back — both are recorded in `dist/manifest.json`
  (`models_dev_skipped_models`, `skipped_no_context_window`), and the row appears
  as soon as a registry learns the limit. Every active model in the document
  therefore has `context_window > 0` (the validator's MODEL_LIMITS rule).
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
| `overrides/local-providers.yaml` (this repo) | Providers Omnipus ships that are absent from models.dev (`ollama`, `vllm`, `litellm`, `lmstudio`, `codex-cli`, `openai-chatgpt`, `github-copilot`, `shengsuanyun`, `volcengine`, `avian`, `mimo`) | MIT (this repo) |

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
