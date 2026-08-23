# Spec validator (independent of the assembler)

`npm run validate:spec -- <providers_catalog.json>` checks a produced document
against the invariants of the Omnipus spec
`docs/internal/specs/adr-067-registry-catalog-spec.md` (FR-001/002/018/026/030/033/039,
DS-1, §5 "Integration Boundaries") and ADR-067 §2/§4.2. It is written from the spec
text only — it does not import or read the assembler's code — so that the two can
disagree and the disagreement shows up here. Zero dependencies; Node 20+.

It prints one row per check (PASS/FAIL, spec citation, violation count, up to five
offending JSON paths) and exits 1 on any failure. `--json` gives the same report as
JSON; `--quiet` prints only PASS/FAIL.

```
npm run validate:spec -- providers_catalog.json
npm run validate:spec:test      # self-test against fixtures/
npm run fixtures                # regenerate fixtures/ from fixtures/gen.mjs
```

## Fixtures

- `fixtures/valid-minimal.json` — the smallest document that passes every check. It
  is "minimal" relative to the set checks, so it still has to carry the 8 popular
  providers, the 5 cloud-IAM rows plus `azure`, and the 11 local-file providers.
  Every URL, name and number in it is a placeholder that satisfies the shape rules;
  none is a verified registry value, and no registry (OpenRouter included) was read
  to produce it.
- `fixtures/invalid/<CHECK>.json` — exactly one document per check, each a single
  targeted mutation of the valid document (`fixtures/gen.mjs` is the source of
  truth). `SIZE.json` is 8 MB + 1 byte and is gitignored; `npm run fixtures` or the
  self-test regenerates it.

## Checks

| Check | Spec | Rule |
|---|---|---|
| JSON | §5 | file parses to a JSON object |
| SIZE | FR-026 | document ≤ 8 MB |
| SCHEMA_VERSION | FR-001 | `schema_version` is exactly `2.0.0` |
| VERSION | FR-002 / F-01 | `version` matches `^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$` |
| UPDATED_AT | FR-002 | non-empty RFC 3339 timestamp |
| SOURCE | FR-002 | non-empty string |
| DEFAULT_RESIZE | FR-002 / DS-1.15 | positive `long_edge_px` and `max_bytes` |
| PROVIDERS_MIN | FR-002 / DS-1.11 | ≥ 1 provider |
| PROVIDER_ID | FR-002 / DS-1.5 | non-empty, unique ids |
| PROVIDER_NAME | §5 / FR-030 | non-empty `name` |
| TIER | FR-002 | `popular` / `standard` / `unsupported` |
| UNSUPPORTED_REASON | §5 / FR-026 / F-35 | present iff `tier: unsupported`; `cloud-iam` / `deployment-url` / `withdrawn` |
| PROTOCOL | FR-002 / F-19 | 5-value enum; empty only when unsupported |
| API_PRESENCE | §5 | `api` non-empty unless unsupported |
| API_URL | FR-033 | `api` and `protocols[].api`: absolute `https`, host present, no userinfo/query/fragment, host not a loopback / link-local (incl. `169.254.169.254`) / RFC 1918 / ULA / unspecified IP literal; rows with derived `locality = local` may use `http` and any host |
| PROTOCOLS_LIST | FR-002 / F-19 | entries unique and in the enum; includes the primary with the same `api` |
| AUTH_METHODS | FR-002 / DS-1.16 | non-empty subset of `{api_key, sign_in}` |
| CLI_KIND | §5 / X-14 | `codex` / `copilot`, present iff `protocol: cli` |
| RESIZE_LIMITS | §5 | positive `long_edge_px` and `max_bytes` |
| NO_CUSTOM | FR-026 / FR-035 | no `custom: true` row |
| NEVER_PUBLISHED | §5 / X-11 / X-16 | `locality` and `subscription_policy` absent |
| MODEL_ID | FR-002 / DS-1.6 | non-empty ids, unique within the provider |
| MODEL_SHAPE | FR-002 / §5 | `context_window`/`max_output_tokens` ints ≥ 0, `tool_call` bool, `status` enum, `release_date` `YYYY-MM-DD`, `disputed` bool |
| MODEL_TEXT | FR-002 / DS-1.8 | `input_modalities` includes `text` |
| MODEL_LIMITS | task rule | non-retired models have `context_window > 0` and `max_output_tokens ≥ 0` |
| ALIASES | FR-030 / A-9 | strings; no alias equals any provider id |
| POPULAR | FR-018 / US-8.AC1 | `tier: popular` is exactly `openai, openrouter, anthropic, google, xai, groq, mistral, deepseek` |
| CLOUD_IAM | US-8.AC2 / FR-026 | `amazon-bedrock`, `google-vertex`, `google-vertex-anthropic`, `watsonx`, `sap-ai-core` present as `unsupported` / `cloud-iam`; `azure` present as `unsupported` / `deployment-url` |
| LOCAL_FILE_PROVIDERS | US-2.AC4 / FR-026 | the 11 local-file ids are present |

Locality is derived as the spec says (FR-039 / F-03): `local ⇔ protocol ∈ {ollama, vllm} ∨ id ∈ {lmstudio, vllm}`, else `cloud`. It is only used for the URL exception; it is never expected in the document.

## Readings of the spec that a reader should know about

These are choices made where the spec text is loose or self-inconsistent. Each is flagged rather than silently picked.

1. **Cloud-IAM count.** US-8.AC2 and ADR-067 §4.1 enumerate **five** cloud-IAM ids; the CLOUD_IAM check uses those five plus `azure` (`deployment-url`, from the §5 disposition table and FR-026). If a sixth cloud-IAM id is intended, add it to `CLOUD_IAM` in `validate-spec.mjs`.
2. **Local-file provider count.** FR-026 says "the nine local-file providers"; US-2.AC4 and the HP scenario enumerate **eleven**. The enumerated list is what is checked.
3. **`protocol: vllm`.** FR-039 names a protocol `vllm` that is not in the FR-002 enum; F-03 and DS-1.22 use the *id* `vllm`. Both spellings count as local, and `vllm` as a `protocol` value is still rejected by PROTOCOL.
4. **8 MB.** FR-026 says "≤ 8 MB" without a unit system; the cap is 8 × 1024 × 1024 bytes. The 16 MB figure in FR-009 is the consumer's download cap, not the publication limit.
5. **MODEL_LIMITS is stricter than the consumer.** US-1.AC5 says the *consumer accepts* `context_window: 0` as "unknown". The task for this validator asked for a publication-quality rule — every non-retired model must have a real window — so a produced document with an active model at `0` fails here even though Omnipus would load it.
6. **Hostnames.** FR-033 forbids *IP literals* in private ranges. A DNS name such as `localhost` is not an IP literal and is not rejected on a hosted row; extend `checkHostedURL` if that should change.
7. **`api` on `cli` rows.** The spec requires `api` non-empty unless unsupported and does not carve out `cli`; the fixtures therefore give `codex-cli`/`github-copilot` a placeholder URL. If the assembler publishes `cli` rows with an empty `api`, API_PRESENCE will flag it and the spec should be clarified.
