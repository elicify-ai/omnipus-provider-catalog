#!/usr/bin/env node
// Independent validator for providers_catalog.json against the ADR-067 spec.
//
// Every rule below cites the Omnipus spec it is read from:
//   docs/internal/specs/adr-067-registry-catalog-spec.md  (FR-nnn, DS-1 rows, §5
//   "Integration Boundaries" document shape) and ADR-067 §2 (D1) / §4.2.
// It is written WITHOUT reference to the assembler's code, so that the two can
// disagree and the disagreement is visible.
//
// Usage:  node validator/validate-spec.mjs <file> [--json] [--quiet]
// Exit:   0 when every check passes, 1 on any failure, 2 on a usage/parse error.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants read from the spec
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "2.0.0"; // FR-001
export const VERSION_RE = /^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/; // FR-002, F-01
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // FR-026 "embedded snapshot MUST be <= 8 MB" (MiB assumed; see README)
export const PROTOCOLS = ["openai-compatible", "anthropic", "google", "ollama", "cli"]; // FR-002, FR-012
export const TIERS = ["popular", "standard", "unsupported"]; // FR-002, §5
export const UNSUPPORTED_REASONS = ["cloud-iam", "deployment-url", "withdrawn"]; // §5 document shape
export const AUTH_METHODS = ["api_key", "sign_in"]; // FR-002
export const CLI_KINDS = ["codex", "copilot"]; // §5, X-14
export const MODEL_STATUSES = ["active", "retired"]; // FR-002
export const POPULAR = ["openai", "openrouter", "anthropic", "google", "xai", "groq", "mistral", "deepseek"]; // FR-018, US-8.AC1
// US-8.AC2 / ADR-067 §4.1 list exactly these five cloud-IAM providers.
export const CLOUD_IAM = ["amazon-bedrock", "google-vertex", "google-vertex-anthropic", "watsonx", "sap-ai-core"];
// §5 factory disposition table / FR-026: azure is unsupported with reason deployment-url.
export const DEPLOYMENT_URL = ["azure"];
// US-2.AC4 enumerates eleven local-file providers (FR-026 says "nine"; the list wins — see README).
export const LOCAL_FILE_PROVIDERS = [
  "ollama", "vllm", "litellm", "lmstudio", "codex-cli", "openai-chatgpt",
  "github-copilot", "shengsuanyun", "volcengine", "avian", "mimo",
];
// Fields the spec says are never published (§5: locality derived by the consumer; X-11: subscription_policy dropped;
// FR-026/FR-035: custom rows are never in the document).
export const NEVER_PUBLISHED_PROVIDER_FIELDS = ["locality", "subscription_policy"];

// ---------------------------------------------------------------------------
// Locality derivation (FR-039, F-03, DS-1 rows 22 and E13 outline)
// local <=> protocol in {ollama, vllm} OR id in {lmstudio, vllm}.
// FR-039 names a protocol "vllm" that is not in the protocol enum; F-03 and the
// E13 outline use the ID vllm. Both spellings are honoured here.
// ---------------------------------------------------------------------------
export function deriveLocality(provider) {
  const p = provider?.protocol;
  const id = provider?.id;
  if (p === "ollama" || p === "vllm" || id === "lmstudio" || id === "vllm") return "local";
  return "cloud";
}

// ---------------------------------------------------------------------------
// URL rules (FR-033)
// ---------------------------------------------------------------------------
function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isForbiddenIPv4(parts) {
  const [a, b] = parts;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local/metadata"; // includes 169.254.169.254
  if (a === 10) return "rfc1918";
  if (a === 172 && b >= 16 && b <= 31) return "rfc1918";
  if (a === 192 && b === 168) return "rfc1918";
  return null;
}

function isForbiddenIPv6(hostRaw) {
  const host = hostRaw.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return null;
  if (host === "::1" || host === "::") return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) {
    const parts = ipv4Parts(mapped[1]);
    return parts ? isForbiddenIPv4(parts) : null;
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return "ula";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  return null;
}

// Returns null when acceptable, otherwise a reason string.
export function checkHostedURL(value, { local }) {
  if (typeof value !== "string" || value === "") return "empty";
  let u;
  try {
    u = new URL(value);
  } catch {
    return "not an absolute URL";
  }
  if (!u.hostname) return "empty host";
  if (u.username || u.password) return "userinfo present";
  if (u.search) return "query present";
  if (u.hash) return "fragment present";
  if (local) {
    if (u.protocol !== "https:" && u.protocol !== "http:") return `scheme ${u.protocol} not http/https`;
    return null; // local rows MAY use http and local hosts
  }
  if (u.protocol !== "https:") return `scheme ${u.protocol} is not https`;
  const v4 = ipv4Parts(u.hostname);
  if (v4) {
    const why = isForbiddenIPv4(v4);
    if (why) return `host is a ${why} IP literal`;
  }
  const v6 = isForbiddenIPv6(u.hostname);
  if (v6) return `host is a ${v6} IPv6 literal`;
  return null;
}

// ---------------------------------------------------------------------------
// Check framework
// ---------------------------------------------------------------------------
const isInt = (v) => Number.isInteger(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isStr = (v) => typeof v === "string";
const isNonEmptyStr = (v) => typeof v === "string" && v.length > 0;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const CHECKS = [
  { id: "JSON", spec: "§5", title: "file is a JSON object" },
  { id: "SIZE", spec: "FR-026", title: "document <= 8 MB" },
  { id: "SCHEMA_VERSION", spec: "FR-001", title: "schema_version is exactly 2.0.0" },
  { id: "VERSION", spec: "FR-002 / F-01", title: "version matches ^v\\d{4}\\.\\d{1,2}\\.\\d{1,2}(\\.\\d+)?$" },
  { id: "UPDATED_AT", spec: "FR-002 / §5", title: "updated_at is a non-empty RFC 3339 timestamp" },
  { id: "SOURCE", spec: "FR-002", title: "source is a non-empty string" },
  { id: "DEFAULT_RESIZE", spec: "FR-002 / DS-1.15", title: "default_resize_limits has positive long_edge_px and max_bytes" },
  { id: "PROVIDERS_MIN", spec: "FR-002 / DS-1.11", title: "providers is an array with >= 1 entry" },
  { id: "PROVIDER_ID", spec: "FR-002 / DS-1.5", title: "provider ids are non-empty, unique strings" },
  { id: "PROVIDER_NAME", spec: "§5 / FR-030", title: "provider name is a non-empty string" },
  { id: "TIER", spec: "FR-002", title: "tier in {popular, standard, unsupported}" },
  { id: "UNSUPPORTED_REASON", spec: "§5 / FR-026 / F-35", title: "unsupported_reason present iff tier unsupported, and in the enum" },
  { id: "PROTOCOL", spec: "FR-002 / F-19", title: "protocol in the 5-value enum; empty only when tier unsupported" },
  { id: "API_PRESENCE", spec: "§5", title: "api non-empty unless tier unsupported" },
  { id: "API_URL", spec: "FR-033", title: "api and protocols[].api obey the hosted-URL rules (local rows exempt)" },
  { id: "PROTOCOLS_LIST", spec: "FR-002 / F-19", title: "protocols[] entries unique, in enum, and include the primary with the same api" },
  { id: "AUTH_METHODS", spec: "FR-002 / DS-1.16", title: "auth_methods non-empty subset of {api_key, sign_in}" },
  { id: "CLI_KIND", spec: "§5 / X-14", title: "cli_kind in {codex, copilot} iff protocol cli" },
  { id: "RESIZE_LIMITS", spec: "§5", title: "resize_limits has positive long_edge_px and max_bytes" },
  { id: "NO_CUSTOM", spec: "FR-026 / FR-035", title: "no provider row carries custom: true" },
  { id: "NEVER_PUBLISHED", spec: "§5 / X-11 / X-16", title: "locality and subscription_policy are not published" },
  { id: "MODEL_ID", spec: "FR-002 / DS-1.6", title: "model ids are non-empty strings, unique within the provider" },
  { id: "MODEL_SHAPE", spec: "FR-002 / §5", title: "model fields typed: ints >= 0, tool_call bool, status enum, release_date YYYY-MM-DD, disputed bool" },
  { id: "MODEL_TEXT", spec: "FR-002 / DS-1.8", title: "every model's input_modalities includes text" },
  { id: "MODEL_LIMITS", spec: "task rule (publication quality)", title: "non-retired models have context_window > 0 and max_output_tokens >= 0" },
  { id: "ALIASES", spec: "FR-030 / A-9", title: "aliases are strings and never equal any provider id" },
  { id: "POPULAR", spec: "FR-018 / US-8.AC1", title: "tier popular is exactly the eight pinned ids" },
  { id: "CLOUD_IAM", spec: "US-8.AC2 / FR-026", title: "the cloud-IAM providers are present, unsupported, reason cloud-iam; azure is deployment-url" },
  { id: "LOCAL_FILE_PROVIDERS", spec: "US-2.AC4 / FR-026", title: "the local-file providers are present" },
];

/**
 * Validate a document. `bytes` is the raw file content (Buffer or string);
 * returns { results: [{id, spec, title, ok, count, examples[]}], stats, fatal }.
 */
export function validateDocument(bytes) {
  const size = Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes);
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  const viol = new Map(CHECKS.map((c) => [c.id, []]));
  const add = (id, path, msg) => viol.get(id).push(`${path}: ${msg}`);
  const stats = { bytes: size, providers: 0, models: 0 };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    add("JSON", "$", `parse error: ${e.message}`);
  }
  if (doc !== undefined && !isObj(doc)) add("JSON", "$", "top level is not an object");
  if (size > MAX_DOCUMENT_BYTES) add("SIZE", "$", `${size} bytes > ${MAX_DOCUMENT_BYTES}`);

  if (isObj(doc)) {
    if (doc.schema_version !== SCHEMA_VERSION) add("SCHEMA_VERSION", "schema_version", `got ${JSON.stringify(doc.schema_version)}`);
    if (!isStr(doc.version) || !VERSION_RE.test(doc.version)) add("VERSION", "version", `got ${JSON.stringify(doc.version)}`);
    if (!isNonEmptyStr(doc.updated_at)) add("UPDATED_AT", "updated_at", "missing or empty");
    else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(doc.updated_at) || Number.isNaN(Date.parse(doc.updated_at)))
      add("UPDATED_AT", "updated_at", `not RFC 3339: ${JSON.stringify(doc.updated_at)}`);
    if (!isNonEmptyStr(doc.source)) add("SOURCE", "source", "missing or empty");
    const d = doc.default_resize_limits;
    if (!isObj(d)) add("DEFAULT_RESIZE", "default_resize_limits", "missing or not an object");
    else {
      if (!isPosInt(d.long_edge_px)) add("DEFAULT_RESIZE", "default_resize_limits.long_edge_px", `got ${JSON.stringify(d.long_edge_px)}`);
      if (!isPosInt(d.max_bytes)) add("DEFAULT_RESIZE", "default_resize_limits.max_bytes", `got ${JSON.stringify(d.max_bytes)}`);
    }

    const providers = Array.isArray(doc.providers) ? doc.providers : null;
    if (!providers || providers.length === 0) add("PROVIDERS_MIN", "providers", providers ? "empty" : "missing or not an array");

    const ids = new Map(); // id -> first index
    const allIDs = new Set();
    (providers || []).forEach((p, i) => {
      if (isObj(p) && isNonEmptyStr(p.id)) allIDs.add(p.id);
    });

    (providers || []).forEach((p, i) => {
      const P = `providers[${i}]`;
      if (!isObj(p)) {
        add("PROVIDER_ID", P, "not an object");
        return;
      }
      stats.providers++;
      if (!isNonEmptyStr(p.id)) add("PROVIDER_ID", `${P}.id`, "missing or empty");
      else if (ids.has(p.id)) add("PROVIDER_ID", `${P}.id`, `duplicate of providers[${ids.get(p.id)}]`);
      else ids.set(p.id, i);

      if (!isNonEmptyStr(p.name)) add("PROVIDER_NAME", `${P}.name`, "missing or empty");

      const unsupported = p.tier === "unsupported";
      if (!TIERS.includes(p.tier)) add("TIER", `${P}.tier`, `got ${JSON.stringify(p.tier)}`);

      if (unsupported) {
        if (!UNSUPPORTED_REASONS.includes(p.unsupported_reason))
          add("UNSUPPORTED_REASON", `${P}.unsupported_reason`, `required when tier unsupported; got ${JSON.stringify(p.unsupported_reason)}`);
      } else if (p.unsupported_reason !== undefined && p.unsupported_reason !== "") {
        add("UNSUPPORTED_REASON", `${P}.unsupported_reason`, `present on tier ${JSON.stringify(p.tier)}`);
      }

      const protoEmpty = p.protocol === undefined || p.protocol === "";
      if (protoEmpty) {
        if (!unsupported) add("PROTOCOL", `${P}.protocol`, "empty but tier is not unsupported");
      } else if (!PROTOCOLS.includes(p.protocol)) add("PROTOCOL", `${P}.protocol`, `got ${JSON.stringify(p.protocol)}`);

      const local = deriveLocality(p) === "local";
      const apiEmpty = p.api === undefined || p.api === "";
      if (apiEmpty) {
        if (!unsupported) add("API_PRESENCE", `${P}.api`, "empty but tier is not unsupported");
      } else if (!isStr(p.api)) add("API_PRESENCE", `${P}.api`, "not a string");
      else {
        const why = checkHostedURL(p.api, { local });
        if (why) add("API_URL", `${P}.api`, `${why} (${p.api})`);
      }

      if (p.protocols !== undefined) {
        if (!Array.isArray(p.protocols)) add("PROTOCOLS_LIST", `${P}.protocols`, "not an array");
        else {
          const seen = new Set();
          let hasPrimary = false;
          p.protocols.forEach((e, j) => {
            const E = `${P}.protocols[${j}]`;
            if (!isObj(e)) { add("PROTOCOLS_LIST", E, "not an object"); return; }
            if (!PROTOCOLS.includes(e.protocol)) add("PROTOCOLS_LIST", `${E}.protocol`, `got ${JSON.stringify(e.protocol)}`);
            const key = `${e.protocol} ${e.api}`;
            if (seen.has(key)) add("PROTOCOLS_LIST", E, "duplicate entry");
            seen.add(key);
            if (e.protocol === p.protocol && e.api === p.api) hasPrimary = true;
            if (isNonEmptyStr(e.api)) {
              const why = checkHostedURL(e.api, { local });
              if (why) add("API_URL", `${E}.api`, `${why} (${e.api})`);
            } else add("PROTOCOLS_LIST", `${E}.api`, "missing or empty");
          });
          if (!protoEmpty && !hasPrimary) add("PROTOCOLS_LIST", `${P}.protocols`, `does not include the primary (${p.protocol}, ${p.api})`);
        }
      }

      if (!Array.isArray(p.auth_methods) || p.auth_methods.length === 0) add("AUTH_METHODS", `${P}.auth_methods`, "missing or empty");
      else p.auth_methods.forEach((m, j) => { if (!AUTH_METHODS.includes(m)) add("AUTH_METHODS", `${P}.auth_methods[${j}]`, `got ${JSON.stringify(m)}`); });

      if (p.protocol === "cli") {
        if (!CLI_KINDS.includes(p.cli_kind)) add("CLI_KIND", `${P}.cli_kind`, `required for protocol cli; got ${JSON.stringify(p.cli_kind)}`);
      } else if (p.cli_kind !== undefined && p.cli_kind !== "") add("CLI_KIND", `${P}.cli_kind`, `present on protocol ${JSON.stringify(p.protocol)}`);

      const r = p.resize_limits;
      if (!isObj(r)) add("RESIZE_LIMITS", `${P}.resize_limits`, "missing or not an object");
      else {
        if (!isPosInt(r.long_edge_px)) add("RESIZE_LIMITS", `${P}.resize_limits.long_edge_px`, `got ${JSON.stringify(r.long_edge_px)}`);
        if (!isPosInt(r.max_bytes)) add("RESIZE_LIMITS", `${P}.resize_limits.max_bytes`, `got ${JSON.stringify(r.max_bytes)}`);
      }

      if (p.custom === true) add("NO_CUSTOM", `${P}.custom`, "custom rows are never in the document");
      for (const f of NEVER_PUBLISHED_PROVIDER_FIELDS) if (f in p) add("NEVER_PUBLISHED", `${P}.${f}`, "must not be published");

      if (p.aliases !== undefined) {
        if (!Array.isArray(p.aliases)) add("ALIASES", `${P}.aliases`, "not an array");
        else p.aliases.forEach((a, j) => {
          if (!isNonEmptyStr(a)) add("ALIASES", `${P}.aliases[${j}]`, "not a non-empty string");
          else if (allIDs.has(a)) add("ALIASES", `${P}.aliases[${j}]`, `collides with provider id ${JSON.stringify(a)}`);
        });
      }

      if (!Array.isArray(p.models)) { add("MODEL_ID", `${P}.models`, "missing or not an array"); return; }
      const mids = new Map();
      p.models.forEach((m, j) => {
        const M = `${P}.models[${j}]`;
        if (!isObj(m)) { add("MODEL_ID", M, "not an object"); return; }
        stats.models++;
        if (!isNonEmptyStr(m.id)) add("MODEL_ID", `${M}.id`, "missing or empty");
        else if (mids.has(m.id)) add("MODEL_ID", `${M}.id`, `duplicate of models[${mids.get(m.id)}]`);
        else mids.set(m.id, j);

        if (!isNonEmptyStr(m.name)) add("MODEL_SHAPE", `${M}.name`, "missing or empty");
        if (!isInt(m.context_window) || m.context_window < 0) add("MODEL_SHAPE", `${M}.context_window`, `got ${JSON.stringify(m.context_window)}`);
        if (!isInt(m.max_output_tokens) || m.max_output_tokens < 0) add("MODEL_SHAPE", `${M}.max_output_tokens`, `got ${JSON.stringify(m.max_output_tokens)}`);
        if (typeof m.tool_call !== "boolean") add("MODEL_SHAPE", `${M}.tool_call`, `got ${JSON.stringify(m.tool_call)}`);
        if (!MODEL_STATUSES.includes(m.status)) add("MODEL_SHAPE", `${M}.status`, `got ${JSON.stringify(m.status)}`);
        if (m.release_date !== undefined && (!isStr(m.release_date) || !/^\d{4}-\d{2}-\d{2}$/.test(m.release_date) || Number.isNaN(Date.parse(m.release_date))))
          add("MODEL_SHAPE", `${M}.release_date`, `got ${JSON.stringify(m.release_date)}`);
        if (m.disputed !== undefined && typeof m.disputed !== "boolean") add("MODEL_SHAPE", `${M}.disputed`, `got ${JSON.stringify(m.disputed)}`);

        if (!Array.isArray(m.input_modalities) || !m.input_modalities.includes("text")) add("MODEL_TEXT", `${M}.input_modalities`, `got ${JSON.stringify(m.input_modalities)}`);

        if (m.status !== "retired") {
          if (!(isInt(m.context_window) && m.context_window > 0)) add("MODEL_LIMITS", `${M}.context_window`, `must be > 0 for status ${JSON.stringify(m.status)}; got ${JSON.stringify(m.context_window)}`);
          if (!(isInt(m.max_output_tokens) && m.max_output_tokens >= 0)) add("MODEL_LIMITS", `${M}.max_output_tokens`, `must be >= 0; got ${JSON.stringify(m.max_output_tokens)}`);
        }
      });
    });

    // Document-wide set checks.
    const byID = new Map((providers || []).filter(isObj).map((p) => [p.id, p]));
    const popular = (providers || []).filter((p) => isObj(p) && p.tier === "popular").map((p) => p.id).sort();
    const want = [...POPULAR].sort();
    if (JSON.stringify(popular) !== JSON.stringify(want)) {
      for (const id of want) if (!popular.includes(id)) add("POPULAR", `providers[id=${id}]`, "missing from tier popular");
      for (const id of popular) if (!want.includes(id)) add("POPULAR", `providers[id=${id}]`, "tier popular but not in the pinned set");
    }
    for (const id of CLOUD_IAM) {
      const p = byID.get(id);
      if (!p) add("CLOUD_IAM", `providers[id=${id}]`, "missing");
      else if (p.tier !== "unsupported" || p.unsupported_reason !== "cloud-iam")
        add("CLOUD_IAM", `providers[id=${id}]`, `tier=${JSON.stringify(p.tier)} reason=${JSON.stringify(p.unsupported_reason)}; want unsupported/cloud-iam`);
    }
    for (const id of DEPLOYMENT_URL) {
      const p = byID.get(id);
      if (!p) add("CLOUD_IAM", `providers[id=${id}]`, "missing");
      else if (p.tier !== "unsupported" || p.unsupported_reason !== "deployment-url")
        add("CLOUD_IAM", `providers[id=${id}]`, `tier=${JSON.stringify(p.tier)} reason=${JSON.stringify(p.unsupported_reason)}; want unsupported/deployment-url`);
    }
    for (const id of LOCAL_FILE_PROVIDERS) if (!byID.has(id)) add("LOCAL_FILE_PROVIDERS", `providers[id=${id}]`, "missing");
  }

  const results = CHECKS.map((c) => {
    const v = viol.get(c.id);
    return { ...c, ok: v.length === 0, count: v.length, examples: v.slice(0, 5) };
  });
  return { results, stats, fatal: !isObj(doc) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function renderTable(report, file) {
  const { results, stats } = report;
  const lines = [];
  lines.push(`providers_catalog validator — ${file}`);
  lines.push(`bytes=${stats.bytes}  providers=${stats.providers}  models=${stats.models}`);
  lines.push("");
  const idW = Math.max(...CHECKS.map((c) => c.id.length));
  const specW = Math.max(...CHECKS.map((c) => c.spec.length));
  lines.push(`${"RESULT".padEnd(6)}  ${"CHECK".padEnd(idW)}  ${"SPEC".padEnd(specW)}  VIOL  RULE`);
  for (const r of results) {
    lines.push(`${(r.ok ? "PASS" : "FAIL").padEnd(6)}  ${r.id.padEnd(idW)}  ${r.spec.padEnd(specW)}  ${String(r.count).padStart(4)}  ${r.title}`);
    for (const ex of r.examples) lines.push(`${"".padEnd(6)}    - ${ex}`);
    if (r.count > r.examples.length) lines.push(`${"".padEnd(6)}    … ${r.count - r.examples.length} more`);
  }
  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((n, r) => n + r.count, 0);
  lines.push("");
  lines.push(`${results.length - failed.length}/${results.length} checks passed, ${failed.length} failed, ${total} violation(s) — ${failed.length ? "FAIL" : "PASS"}`);
  return lines.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const quiet = args.includes("--quiet");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: validate-spec.mjs <providers_catalog.json> [--json] [--quiet]");
    process.exit(2);
  }
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  const report = validateDocument(bytes);
  const ok = report.results.every((r) => r.ok);
  if (json) console.log(JSON.stringify({ file, ok, ...report }, null, 2));
  else if (!quiet) console.log(renderTable(report, file));
  else console.log(`${ok ? "PASS" : "FAIL"} ${file}`);
  process.exit(ok ? 0 : 1);
}
