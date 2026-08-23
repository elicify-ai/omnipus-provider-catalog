# Independent validator

`validator/validate-spec.mjs` checks a `providers_catalog.json` document
against the publication rules a consumer relies on. It is written separately
from the assembler and does not import any of its code, so if the assembler
ever drifts from the rules, the two disagree and the disagreement shows up
here. It has no dependencies and runs on Node 20 or newer.

The daily run executes it on every document before a release is published.
You can also run it on a downloaded release to confirm the file is well-formed.

## How to run it

```bash
npm run validate:spec -- providers_catalog.json
```

The output is one row per check: PASS or FAIL, the area the check belongs to,
the number of violations, and up to five offending JSON paths. The exit code is
`0` when every check passes and `1` when any fails (`2` for a usage or parse
error).

Options: `--json` prints the same report as JSON; `--quiet` prints only
`PASS <file>` or `FAIL <file>`.

## How to run its self-test

```bash
npm run validate:spec:test
```

The self-test confirms that the minimal valid document passes every check, and
that each invalid fixture fails exactly its own check (plus any unavoidable
side-effect failures, which are listed in `test.mjs`).

```bash
npm run fixtures      # regenerate fixtures/ from fixtures/gen.mjs
```

### Fixtures

- `fixtures/valid-minimal.json` — the smallest document that passes every
  check. Because some checks require particular providers to be present, it
  still carries the 8 popular providers, the 5 cloud-IAM providers plus
  `azure`, and the 11 providers that come from `overrides/local-providers.yaml`.
  Every URL, name and number in it is a placeholder that satisfies the shape
  rules; none is a verified registry value, and no registry (OpenRouter
  included) was read to produce it.
- `fixtures/invalid/<CHECK>.json` — one document per check, each a single
  targeted change to the valid document (`fixtures/gen.mjs` is the source of
  truth). `SIZE.json` is 8 MB plus one byte and is not committed; `npm run
  fixtures` or the self-test regenerates it.
- `fixtures/providers_catalog_2.0.0_fixture.json` — a byte-for-byte copy of
  the conformance fixture the Omnipus consumer tests its parser against
  (`pkg/providers/catalog/testdata/providers_catalog_2.0.0_fixture.json` in
  the Omnipus repository). It captures the shared 2.0.0 contract from the
  consumer's side: 3 providers / 6 models, including the same model id under
  two providers with different windows, a second-protocol entry, a `disputed`
  row and a retired row. It is deliberately **not** run through this
  validator's self-test — it is a parser-level contract fixture, not a
  publication candidate, so it does not carry the required popular /
  cloud-IAM / local-provider sets. When the schema contract changes, update
  both copies together.

## The 29 checks

**Whole document**

| Check | What it requires |
|---|---|
| JSON | The file parses as a JSON object. |
| SIZE | The file is 8 MB (8 × 1024 × 1024 bytes) or smaller. |
| SCHEMA_VERSION | `schema_version` is exactly `2.0.0`. |
| VERSION | `version` has the form `vYYYY.M.D` with an optional `.N` counter. |
| UPDATED_AT | `updated_at` is a non-empty RFC 3339 timestamp. |
| SOURCE | `source` is a non-empty string. |
| DEFAULT_RESIZE | `default_resize_limits` has a positive `long_edge_px` and `max_bytes`. |
| PROVIDERS_MIN | There is at least one provider. |

**Each provider**

| Check | What it requires |
|---|---|
| PROVIDER_ID | Ids are non-empty and unique across the document. |
| PROVIDER_NAME | `name` is non-empty. |
| TIER | `tier` is `popular`, `standard` or `unsupported`. |
| UNSUPPORTED_REASON | `unsupported_reason` is present exactly when `tier` is `unsupported`, and is `cloud-iam`, `deployment-url` or `withdrawn`. |
| PROTOCOL | `protocol` is one of the five known values; empty only when the provider is unsupported. |
| API_PRESENCE | `api` is non-empty unless the provider is unsupported. |
| API_URL | `api` and every `protocols[].api` is an absolute `https` URL with a host, no credentials, query or fragment, and not a loopback, link-local (including `169.254.169.254`), private-range, unique-local or unspecified IP address. Local-machine providers (see below) may use `http` and any host. |
| PROTOCOLS_LIST | `protocols` entries are unique and valid, and include the primary `protocol` with the same `api`. |
| AUTH_METHODS | `auth_methods` is a non-empty subset of `api_key`, `sign_in`. |
| CLI_KIND | `cli_kind` is `codex` or `copilot`, present exactly when `protocol` is `cli`. |
| RESIZE_LIMITS | `resize_limits` has a positive `long_edge_px` and `max_bytes`. |
| NO_CUSTOM | No provider carries `custom: true`. |
| NEVER_PUBLISHED | `locality` and `subscription_policy` do not appear. |
| ALIASES | Aliases are strings, and no alias equals any provider id. |

**Each model**

| Check | What it requires |
|---|---|
| MODEL_ID | Ids are non-empty and unique within the provider. |
| MODEL_SHAPE | `context_window` and `max_output_tokens` are integers ≥ 0, `tool_call` is a boolean, `status` is `active` or `retired`, `release_date` (if present) is `YYYY-MM-DD`, `disputed` (if present) is a boolean. |
| MODEL_TEXT | `input_modalities` includes `text`. |
| MODEL_LIMITS | Every model that is not retired has `context_window` greater than 0. |

**Required sets**

| Check | What it requires |
|---|---|
| POPULAR | The providers with `tier: popular` are exactly `openai`, `openrouter`, `anthropic`, `google`, `xai`, `groq`, `mistral`, `deepseek`. |
| CLOUD_IAM | `amazon-bedrock`, `google-vertex`, `google-vertex-anthropic`, `watsonx` and `sap-ai-core` are present as `unsupported` / `cloud-iam`; `azure` is present as `unsupported` / `deployment-url`. |
| LOCAL_FILE_PROVIDERS | The 11 providers defined in `overrides/local-providers.yaml` are all present. |

A provider counts as **local-machine** when its `protocol` is `ollama` or
`vllm`, or its id is `lmstudio` or `vllm`. That only matters for the URL
check; the document never states it.

## Judgement calls a reader should know about

These are choices the validator makes where a rule could be read more than one
way. Each is flagged here rather than silently picked.

1. **Cloud-IAM set.** Five providers are checked for `cloud-iam`, plus `azure`
   for `deployment-url`. To add another, extend `CLOUD_IAM` in
   `validate-spec.mjs`.
2. **Local-file provider count.** Eleven ids are checked, matching
   `overrides/local-providers.yaml`.
3. **`vllm` as a protocol.** Some sources write `vllm` as a protocol, others as
   an id. Both spellings count as local-machine for the URL exception, but
   `vllm` is still rejected as a `protocol` value.
4. **8 MB.** The cap is 8 × 1024 × 1024 bytes.
5. **MODEL_LIMITS is stricter than consumers need.** A consumer may treat
   `context_window: 0` as "unknown" and still load the document. This
   validator enforces publication quality instead: every active model must
   have a real window, so a document with an active model at `0` fails here.
6. **Hostnames.** The URL check forbids private *IP addresses*. A DNS name such
   as `localhost` is not an IP address and is not rejected on a hosted row;
   extend `checkHostedURL` if that should change.
7. **`api` on `cli` rows.** `api` must be non-empty unless the provider is
   unsupported, and there is no exception for `cli`; the fixtures therefore
   give `codex-cli` and `github-copilot` a placeholder URL.
