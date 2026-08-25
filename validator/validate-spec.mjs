#!/usr/bin/env node
// Independent validator for providers_catalog.json: the publication rules a
// consumer relies on, written WITHOUT reference to the assembler's code, so
// that the two can disagree and the disagreement is visible.
//
// Usage:  node validator/validate-spec.mjs <file> [--json] [--quiet]
// Exit:   0 when every check passes, 1 on any failure, 2 on a usage/parse error.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants: the published rules
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "2.0.0";
export const VERSION_RE = /^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/;
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // 8 MB cap on the published document (MiB; see README)
export const PROTOCOLS = ["openai-compatible", "anthropic", "google", "ollama", "cli"];
export const TIERS = ["popular", "standard", "unsupported"];
export const UNSUPPORTED_REASONS = ["cloud-iam", "deployment-url", "withdrawn"];
export const AUTH_METHODS = ["api_key", "sign_in"];
export const CLI_KINDS = ["codex", "copilot"];
export const MODEL_STATUSES = ["active", "retired"];
export const POPULAR = ["openai", "anthropic", "google", "openrouter", "deepseek", "zai", "minimax", "moonshotai", "alibaba", "xai", "mistral", "ollama"]; // the pinned popular set
// The five providers that need a cloud identity sign-in rather than an API key.
export const CLOUD_IAM = ["amazon-bedrock", "google-vertex", "google-vertex-anthropic", "watsonx", "sap-ai-core"];
// azure has a per-deployment URL, so it is unsupported with reason deployment-url.
export const DEPLOYMENT_URL = ["azure"];
// The eleven providers that come from overrides/local-providers.yaml and must always be present.
export const LOCAL_FILE_PROVIDERS = [
  "ollama", "vllm", "litellm", "lmstudio", "codex-cli", "openai-chatgpt",
  "github-copilot", "shengsuanyun", "volcengine", "avian", "mimo",
];
// Fields that are never published: locality is derived by the consumer, and
// subscription_policy was dropped from the shape.
export const NEVER_PUBLISHED_PROVIDER_FIELDS = ["locality", "subscription_policy"];

// ---------------------------------------------------------------------------
// Locality derivation
// local <=> protocol in {ollama, vllm} OR id in {lmstudio, vllm}.
// "vllm" has been written both as a protocol and as an id; both spellings are
// honoured here (as a protocol value it is still rejected by the PROTOCOL check).
// ---------------------------------------------------------------------------
export function deriveLocality(provider) {
  const p = provider?.protocol;
  const id = provider?.id;
  if (p === "ollama" || p === "vllm" || id === "lmstudio" || id === "vllm") return "local";
  return "cloud";
}

// ---------------------------------------------------------------------------
// URL rules for hosted (cloud) rows
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
  { id: "JSON", spec: "document", title: "file is a JSON object" },
  { id: "SIZE", spec: "document", title: "document <= 8 MB" },
  { id: "SCHEMA_VERSION", spec: "document", title: "schema_version is exactly 2.0.0" },
  { id: "VERSION", spec: "document", title: "version matches ^v\\d{4}\\.\\d{1,2}\\.\\d{1,2}(\\.\\d+)?$" },
  { id: "UPDATED_AT", spec: "document", title: "updated_at is a non-empty RFC 3339 timestamp" },
  { id: "SOURCE", spec: "document", title: "source is a non-empty string" },
  { id: "DEFAULT_RESIZE", spec: "document", title: "default_resize_limits has positive long_edge_px and max_bytes" },
  { id: "PROVIDERS_MIN", spec: "document", title: "providers is an array with >= 1 entry" },
  { id: "PROVIDER_ID", spec: "provider", title: "provider ids are non-empty, unique strings" },
  { id: "PROVIDER_NAME", spec: "provider", title: "provider name is a non-empty string" },
  { id: "TIER", spec: "provider", title: "tier in {popular, standard, unsupported}" },
  { id: "UNSUPPORTED_REASON", spec: "provider", title: "unsupported_reason present iff tier unsupported, and in the enum" },
  { id: "PROTOCOL", spec: "provider", title: "protocol in the 5-value enum; empty only when tier unsupported" },
  { id: "API_PRESENCE", spec: "provider", title: "api non-empty unless tier unsupported" },
  { id: "API_URL", spec: "url", title: "api and protocols[].api obey the hosted-URL rules (local rows exempt)" },
  { id: "PROTOCOLS_LIST", spec: "provider", title: "protocols[] entries unique, in enum, and include the primary with the same api" },
  { id: "AUTH_METHODS", spec: "provider", title: "auth_methods non-empty subset of {api_key, sign_in}" },
  { id: "CLI_KIND", spec: "provider", title: "cli_kind in {codex, copilot} iff protocol cli" },
  { id: "RESIZE_LIMITS", spec: "provider", title: "resize_limits has positive long_edge_px and max_bytes" },
  { id: "NO_CUSTOM", spec: "provider", title: "no provider row carries custom: true" },
  { id: "NEVER_PUBLISHED", spec: "provider", title: "locality and subscription_policy are not published" },
  { id: "MODEL_ID", spec: "model", title: "model ids are non-empty strings, unique within the provider" },
  { id: "MODEL_SHAPE", spec: "model", title: "model fields typed: ints >= 0, tool_call bool, status enum, release_date YYYY-MM-DD, disputed bool" },
  { id: "MODEL_TEXT", spec: "model", title: "every model's input_modalities includes text" },
  { id: "MODEL_LIMITS", spec: "model", title: "non-retired models have context_window > 0 and max_output_tokens >= 0" },
  { id: "ALIASES", spec: "provider", title: "aliases are strings and never equal any provider id" },
  { id: "POPULAR", spec: "set", title: "tier popular is exactly the twelve pinned ids" },
  { id: "CLOUD_IAM", spec: "set", title: "the cloud-IAM providers are present, unsupported, reason cloud-iam; azure is deployment-url" },
  { id: "LOCAL_FILE_PROVIDERS", spec: "set", title: "the local-file providers are present" },
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
  lines.push(`${"RESULT".padEnd(6)}  ${"CHECK".padEnd(idW)}  ${"AREA".padEnd(specW)}  VIOL  RULE`);
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
