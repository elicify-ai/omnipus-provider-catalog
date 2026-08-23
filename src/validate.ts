// Output validation — the consumer's rules (spec FR-001/002/026/033, US-1.AC3)
// run here before anything is published, so a bad document never leaves this
// repo. Every finding names the offending path.
import type { Catalog } from "./schema.js";
import { Catalog as CatalogSchema, LOCAL_FILE_PROVIDERS, POPULAR_SET, VERSION_RE } from "./schema.js";
import { compareVersions } from "./version.js";
import { deriveLocality, isLocalHost } from "./finalize.js";

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export type Finding = { path: string; message: string };

export type ValidateOptions = {
  /** The previous release's version; the document's version must be strictly greater. */
  previousVersion?: string | null;
  /** Serialised size to check against the 8 MB cap (computed from the document when omitted). */
  bytes?: number;
};

function checkApiUrl(api: string, path: string, local: boolean, findings: Finding[]): void {
  let u: URL;
  try {
    u = new URL(api);
  } catch {
    findings.push({ path, message: `api ${JSON.stringify(api)} is not an absolute URL` });
    return;
  }
  if (u.username || u.password) findings.push({ path, message: "api must not carry userinfo" });
  if (u.search) findings.push({ path, message: "api must not carry a query string" });
  if (u.hash) findings.push({ path, message: "api must not carry a fragment" });
  if (!u.hostname) findings.push({ path, message: "api must have a host" });
  if (local) {
    if (u.protocol !== "https:" && u.protocol !== "http:") findings.push({ path, message: `api scheme ${u.protocol} is not http or https` });
    return;
  }
  if (u.protocol !== "https:") findings.push({ path, message: `api must be https for a cloud row (got ${u.protocol})` });
  if (u.hostname && isLocalHost(u.hostname)) findings.push({ path, message: `api host ${u.hostname} is loopback/link-local/private/metadata; cloud rows need a public host` });
}

/** Structural + invariant validation. Returns an empty list when the document is publishable. */
export function validateCatalog(doc: unknown, opts: ValidateOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const parsed = CatalogSchema.safeParse(doc);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push({ path: issue.path.join(".") || "(root)", message: issue.message });
    }
    return findings;
  }
  const cat: Catalog = parsed.data;

  if (!VERSION_RE.test(cat.version)) findings.push({ path: "version", message: "must match vYYYY.M.D[.N]" });
  else if (opts.previousVersion && compareVersions(cat.version, opts.previousVersion) <= 0) {
    findings.push({ path: "version", message: `${cat.version} is not greater than the previous release ${opts.previousVersion}` });
  }
  if (Number.isNaN(Date.parse(cat.updated_at))) findings.push({ path: "updated_at", message: "must be an RFC 3339 timestamp" });

  const ids = new Set<string>();
  for (const [i, p] of cat.providers.entries()) {
    const path = `providers[${i}](${p.id})`;
    if (ids.has(p.id)) findings.push({ path, message: `duplicate provider id ${JSON.stringify(p.id)}` });
    ids.add(p.id);
    if (p.id !== p.id.trim() || p.id !== p.id.toLowerCase()) findings.push({ path, message: "provider id must be lowercase and trimmed" });
    if (p.custom === true) findings.push({ path, message: "custom rows are never in the document (FR-026/FR-035)" });

    const unsupported = p.tier === "unsupported";
    if (unsupported && !p.unsupported_reason) findings.push({ path: `${path}.unsupported_reason`, message: "required when tier is unsupported" });
    if (!unsupported && p.unsupported_reason) findings.push({ path: `${path}.unsupported_reason`, message: "only allowed when tier is unsupported" });
    if (!p.protocol && !unsupported) findings.push({ path: `${path}.protocol`, message: "may be empty only when tier is unsupported" });
    if (!p.api && !unsupported) findings.push({ path: `${path}.api`, message: "may be empty only when tier is unsupported" });
    if (p.protocol === "cli" && !p.cli_kind) findings.push({ path: `${path}.cli_kind`, message: "required when protocol is cli" });
    if (p.protocol !== "cli" && p.cli_kind) findings.push({ path: `${path}.cli_kind`, message: "only allowed when protocol is cli" });

    const local = deriveLocality(p) === "local";
    if (p.api) checkApiUrl(p.api, `${path}.api`, local, findings);
    if (p.protocols) {
      const seen = new Set<string>();
      for (const [j, e] of p.protocols.entries()) {
        const k = `${e.protocol}|${e.api}`;
        if (seen.has(k)) findings.push({ path: `${path}.protocols[${j}]`, message: "duplicate protocols entry" });
        seen.add(k);
        if (e.api) checkApiUrl(e.api, `${path}.protocols[${j}].api`, local, findings);
      }
      if (p.protocol && !p.protocols.some((e) => e.protocol === p.protocol && e.api === p.api)) {
        findings.push({ path: `${path}.protocols`, message: "must include the primary protocol with the same api" });
      }
    }

    // Local rows list models live (FR-020) and unsupported rows cannot be configured (FR-019), so only a selectable cloud row must carry models.
    if (p.models.length === 0 && !local && !unsupported) findings.push({ path: `${path}.models`, message: "every selectable cloud provider needs at least one model" });
    const mids = new Set<string>();
    for (const [j, m] of p.models.entries()) {
      const mp = `${path}.models[${j}](${m.id})`;
      if (mids.has(m.id)) findings.push({ path: mp, message: `duplicate model id ${JSON.stringify(m.id)} within provider` });
      mids.add(m.id);
      if (!m.input_modalities.includes("text")) findings.push({ path: `${mp}.input_modalities`, message: "must include text" });
      if (m.release_date && Number.isNaN(Date.parse(m.release_date))) findings.push({ path: `${mp}.release_date`, message: "not a calendar date" });
    }
  }

  for (const [i, p] of cat.providers.entries()) {
    for (const [j, a] of p.aliases.entries()) {
      if (ids.has(a)) findings.push({ path: `providers[${i}](${p.id}).aliases[${j}]`, message: `alias ${JSON.stringify(a)} collides with a provider id; aliases are search-only (A-9)` });
    }
  }

  for (const id of POPULAR_SET) {
    const p = cat.providers.find((x) => x.id === id);
    if (!p) findings.push({ path: "providers", message: `popular provider ${id} is missing` });
    else if (p.tier !== "popular") findings.push({ path: `providers(${id}).tier`, message: "must be popular" });
  }
  for (const id of LOCAL_FILE_PROVIDERS) {
    if (!ids.has(id)) findings.push({ path: "providers", message: `local-file provider ${id} is missing` });
  }

  const bytes = opts.bytes ?? Buffer.byteLength(JSON.stringify(cat));
  if (bytes > MAX_DOCUMENT_BYTES) findings.push({ path: "(root)", message: `document is ${bytes} bytes, over the ${MAX_DOCUMENT_BYTES} byte cap` });

  return findings;
}

/**
 * Serialise; if over the 8 MB cap, drop `status: retired` models first
 * (ADR-067 §8b), then fail if still too large.
 */
export function serialiseWithinCap(cat: Catalog): { json: string; trimmed_retired: number } {
  let json = JSON.stringify(cat, null, 1) + "\n";
  let trimmed = 0;
  if (Buffer.byteLength(json) > MAX_DOCUMENT_BYTES) {
    for (const p of cat.providers) {
      const before = p.models.length;
      p.models = p.models.filter((m) => m.status !== "retired");
      trimmed += before - p.models.length;
    }
    json = JSON.stringify(cat, null, 1) + "\n";
  }
  if (Buffer.byteLength(json) > MAX_DOCUMENT_BYTES) {
    throw new Error(`document is ${Buffer.byteLength(json)} bytes even after trimming ${trimmed} retired models; cap is ${MAX_DOCUMENT_BYTES}`);
  }
  return { json, trimmed_retired: trimmed };
}
