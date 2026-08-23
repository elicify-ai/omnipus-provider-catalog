# omnipus-provider-catalog

A daily-refreshed list of LLM providers and their models, with the limits you
need when you call them: API endpoint, wire protocol, context window, maximum
output, accepted input types, tool-calling support, release date and status.
One JSON file, checked before publication, released every day.

## Why this exists

Every LLM provider publishes its model limits somewhere different, in a
different format, or not at all. The public registries that collect them
disagree with each other and go stale at different rates. This repository
merges the public sources into one checked document and publishes it as a new
release every day, so you do not have to do that merging yourself.

It is an open, MIT-licensed dataset. [Omnipus](https://omnipus.ai) maintains it
and uses it as its own provider list, but nothing in it is specific to that
project.

## Who it is for

Anyone who needs a current list of providers and models and their limits,
without hand-maintaining one:

- agent frameworks and gateways that need to know a model's context window
  before they send a request;
- dashboards and model pickers that want display names, release dates and
  input types;
- scripts that need an endpoint URL and the protocol to speak to it;
- anyone checking "does this model accept PDFs?" or "how many tokens can I
  get back?"

## How to use it

### Download the latest release

Every release carries exactly two files:

| File | What it is |
|---|---|
| `providers_catalog.json` | The catalog document (see [What is in the document](#what-is-in-the-document)). |
| `providers_catalog.json.sha256` | The SHA-256 checksum of that file — a fingerprint you can use to confirm the download is intact. |

The latest release is always at these two URLs:

```
https://github.com/elicify-ai/omnipus-provider-catalog/releases/latest/download/providers_catalog.json
https://github.com/elicify-ai/omnipus-provider-catalog/releases/latest/download/providers_catalog.json.sha256
```

The same two files are also committed to the `main` branch after every release,
so they can be fetched from the raw-file URL of this repository if the Releases
API is unreachable:

```
https://raw.githubusercontent.com/elicify-ai/omnipus-provider-catalog/main/providers_catalog.json
```

### Verify the checksum

```bash
curl -LO https://github.com/elicify-ai/omnipus-provider-catalog/releases/latest/download/providers_catalog.json
curl -LO https://github.com/elicify-ai/omnipus-provider-catalog/releases/latest/download/providers_catalog.json.sha256
sha256sum -c providers_catalog.json.sha256      # prints "providers_catalog.json: OK"
```

On macOS use `shasum -a 256 -c providers_catalog.json.sha256`. The checksum
file holds the 64-character hex digest followed by the file name, the standard
format those tools expect.

The checksum proves the file arrived unchanged. It is not a signature, so it
does not prove who published it; trust in the publisher comes from fetching it
over HTTPS from this GitHub repository.

### Releases and versions

- A new release is assembled **every day at 06:00 UTC**. If the assembled
  document is byte-for-byte identical to the previous release, no new release
  is made.
- Versions are dates: `vYYYY.M.D`, for example `v2026.8.23`. A second run on
  the same day adds a counter: `v2026.8.23.1`, `v2026.8.23.2`, and so on.
  Versions only ever go up.
- Older versions stay available as GitHub Releases, each with its own two
  files, so you can pin to a specific date.
- Inside the document, `version` carries the same value and `updated_at`
  carries the assembly time.

### Read one model's limits

The document is a list of providers, each with a list of models. Look up a
model by its provider id and model id.

With `jq`:

```bash
jq '.providers[] | select(.id == "anthropic")
    | .models[] | select(.id == "claude-haiku-4-5")
    | {context_window, max_output_tokens, input_modalities, tool_call}' providers_catalog.json
```

```json
{
  "context_window": 200000,
  "max_output_tokens": 64000,
  "input_modalities": ["text", "image", "pdf"],
  "tool_call": true
}
```

In Python:

```python
import json

catalog = json.load(open("providers_catalog.json"))
provider = next(p for p in catalog["providers"] if p["id"] == "anthropic")
model = next(m for m in provider["models"] if m["id"] == "claude-haiku-4-5")
print(model["context_window"], model["max_output_tokens"], model["input_modalities"])
```

In JavaScript:

```js
import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile("providers_catalog.json", "utf8"));
const provider = catalog.providers.find((p) => p.id === "anthropic");
const model = provider.models.find((m) => m.id === "claude-haiku-4-5");
console.log(model.context_window, model.max_output_tokens, model.input_modalities);
```

Model ids are exactly what the provider's API expects (`glm-5.2` under `zai`,
`z-ai/glm-5.2` under `openrouter`). A `context_window` of `0` means "unknown".

## What is in the document

The full field-by-field reference, with allowed values and where each value
comes from, is in [`docs/schema-2.0.0.md`](docs/schema-2.0.0.md). In short:

**Top level** — `schema_version` (always `2.0.0`), `version`, `updated_at`,
`source` (which upstream snapshots were used), `default_resize_limits` and the
`providers` list.

**Provider fields**

| Field | Meaning |
|---|---|
| `id`, `name`, `company` | Stable id, display name, and the company it belongs to (for grouping). |
| `api` | The base URL you send requests to. |
| `protocol` | The wire protocol to speak: `openai-compatible`, `anthropic`, `google`, `ollama` or `cli`. |
| `protocols` | Optional list of every protocol and URL pair the provider serves, when there is more than one. |
| `env` | The environment variable names the provider's own tooling conventionally uses for its API key — a hint for UI labels, nothing more. |
| `tier` | `popular`, `standard` or `unsupported`. |
| `unsupported_reason` | Why an `unsupported` provider cannot be called directly: needs cloud IAM sign-in, needs a per-deployment URL, or was withdrawn upstream. |
| `auth_methods` | How you authenticate: `api_key`, `sign_in`, or both. |
| `aliases` | Extra search strings (for example `claude` for `anthropic`). |
| `region`, `plan` | Optional hints such as `cn` or `coding-plan`. |
| `cli_kind`, `token_source` | Only for providers driven through a command-line tool rather than HTTP. |
| `resize_limits` | The largest image the provider accepts: long edge in pixels and size in bytes. |
| `models` | The provider's models. |

**Model fields**

| Field | Meaning |
|---|---|
| `id`, `name` | The id you put in the API request, and a display name. |
| `release_date` | `YYYY-MM-DD`, when known. |
| `context_window` | How much the model can take in at once (prompt plus reply), in tokens. `0` = unknown. |
| `max_output_tokens` | The longest reply the model can produce, in tokens. `0` = unknown. |
| `input_modalities` | What the model accepts as input: always `text`, plus any of `image`, `pdf`, `audio`, `video`. |
| `tool_call` | Whether the model supports tool calling (function calling). |
| `status` | `active`, or `retired` when the model has disappeared from the upstream sources. |
| `disputed` | Present and `true` while the sources disagree about this model (see below). |

Only text-generating models are included. Image, video and speech generators
are left out, as is any model for which no source knows the context window.

## Where the data comes from

The catalog is **merged from public registries plus a small set of maintained
corrections**. It is not verified against each vendor's documentation on every
run; values are as good as the sources and the corrections people have
contributed.

| Source | Used for | Licence |
|---|---|---|
| [models.dev](https://models.dev) (`api.json`) | Primary source: providers, endpoints, protocols, model limits, input types, tool calling, release dates | MIT |
| [LiteLLM](https://github.com/BerriAI/litellm) (`model_prices_and_context_window.json`) | Cross-check: compared against models.dev to catch disagreements, and used to fill in limits models.dev does not know | MIT |
| [`overrides/`](overrides/README.md) (this repository) | Hand-maintained corrections and additions, each with a stated reason | MIT |
| [`resize_limits.json`](resize_limits.json) (this repository) | Per-provider image upload limits, which neither registry carries | MIT |

Each release records exactly which snapshot of each source it used (the
upstream commit id) in the document's `source` and `sources` fields.

**Not used:** OpenRouter's own model list, because OpenRouter's terms of
service do not permit copying its data. (OpenRouter still appears as a
provider, using the table models.dev publishes for it.)

### When the sources disagree

For each number (context window, maximum output) the two registries are
compared:

- **Small differences** — within 5 % or 4,096 tokens, whichever is larger —
  are not treated as a conflict. The **lower** of the two values is published,
  and both values are recorded in the run's manifest.
- **Larger differences** are treated as a dispute. The value from the previous
  release stays in place (models.dev's value if there is no previous release),
  the model is marked `"disputed": true`, and the daily run opens one GitHub
  issue listing every disputed row. A dispute never blocks a release.
- For yes/no facts such as tool calling and input types, any explicit
  disagreement is a dispute, handled the same way.
- A value written into `overrides/` settles the dispute for that field on the
  next run.

Providers and models that vanish from the sources are not silently dropped:
a vanished model is carried forward as `status: retired`, a vanished provider
as `tier: unsupported` with reason `withdrawn`.

## How to correct or add something

Corrections live in three YAML files under [`overrides/`](overrides/README.md).
They win over both registries, and every row must state a `reason` — an issue
number, a documentation link, or a dated check you performed.

For example, to state that a model accepts PDF input when the registries say
otherwise, add to `overrides/models.yaml`:

```yaml
models:
  google:
    gemini-3-pro:
      reason: "Issue #42: the API accepts PDFs; checked against the docs on 2026-08-23."
      input_modalities: [text, image, audio, video, pdf]
```

Open a pull request with the change. Once merged, the next daily run picks it
up and the corrected value appears in the next release. Pull requests are
welcome, including new providers (`overrides/local-providers.yaml`) and base
URLs the registries are missing (`overrides/providers.yaml`). The
[`overrides/README.md`](overrides/README.md) explains all three files.

## Running the assembler yourself

You do not need this to use the catalog; it is for contributors. Requires
Node 22+.

```bash
npm ci
npm run assemble        # fetch both registries, merge, apply overrides, validate → dist/
npm run validate        # re-check dist/providers_catalog.json
npm test                # unit tests
```

`npm run assemble -- --offline` reuses the last downloaded registries from
`.cache/`. The output in `dist/` is the document, its checksum and a
`manifest.json` describing everything the run decided (values picked, fills,
disputes, overrides applied).

## Licence and attribution

This repository, including the published catalog, is licensed under the
[MIT License](LICENSE), copyright 2026 Elicify AI.

The data is derived from [models.dev](https://models.dev) and
[LiteLLM](https://github.com/BerriAI/litellm), both MIT-licensed. If you
redistribute the catalog, please keep this attribution.
