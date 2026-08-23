// Finalisation: fill the fields neither registry carries with their defaults,
// derive locality, join resize_limits.json, and settle the unsupported tier
// for rows that have no protocol/URL Omnipus can use.
import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { Provider, ResizeLimits as ResizeLimitsT } from "./schema.js";
import { ResizeLimits } from "./schema.js";
import type { WorkingProvider } from "./overrides.js";

export const ResizeFile = z
  .object({
    _comment: z.string().optional(),
    default: ResizeLimits,
    providers: z.record(ResizeLimits),
  })
  .strict();
export type ResizeFile = z.infer<typeof ResizeFile>;

export async function loadResizeLimits(file: string): Promise<ResizeFile> {
  return ResizeFile.parse(JSON.parse(await readFile(file, "utf8")));
}

export function hostOf(api: string): string | null {
  try {
    return new URL(api).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Loopback, link-local, RFC 1918, ULA, metadata, or a bare hostname with no dot. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare single-label host (e.g. `ollama`)
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (h.includes(":")) {
    const low = h.toLowerCase();
    return low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb");
  }
  return false;
}

/**
 * Locality exactly as the consumer derives it (spec FR-039, for published rows):
 * local ⇔ protocol ollama ∨ id ∈ {vllm, lmstudio}. Nothing else counts — a
 * loopback URL on any other row would make Omnipus reject the whole document
 * (FR-033), so such rows are marked unsupported in finalizeProviders instead.
 */
export function deriveLocality(p: { id: string; protocol: string }): "local" | "cloud" {
  if (p.protocol === "ollama" || p.id === "vllm" || p.id === "lmstudio") return "local";
  return "cloud";
}

/** True when `api` is an absolute https URL on a public host (the FR-033 rule for cloud rows). */
export function isPublicHttps(api: string): boolean {
  let u: URL;
  try {
    u = new URL(api);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.search || u.hash) return false;
  return !isLocalHost(u.hostname);
}

export type FinalizeReport = {
  auto_unsupported: { id: string; why: string }[];
};

export function finalizeProviders(providers: WorkingProvider[], resize: ResizeFile): { providers: Provider[]; report: FinalizeReport } {
  const report: FinalizeReport = { auto_unsupported: [] };
  const out: Provider[] = [];
  for (const w of [...providers].sort((a, b) => a.id.localeCompare(b.id))) {
    const locality = deriveLocality(w);
    let tier = w.tier ?? "standard";
    let reason = w.unsupported_reason;
    if (tier !== "unsupported") {
      if (!w.protocol) {
        tier = "unsupported";
        reason = reason ?? "deployment-url";
        report.auto_unsupported.push({ id: w.id, why: `no Omnipus protocol for npm ${JSON.stringify(w.npm)} and no override` });
      } else if (!w.api && locality === "cloud") {
        tier = "unsupported";
        reason = reason ?? "deployment-url";
        report.auto_unsupported.push({
          id: w.id,
          why: w.api_is_template ? "models.dev api is a ${VAR} template (deployment-specific)" : "no base URL from models.dev and no override",
        });
      } else if (w.api && locality === "cloud" && !isPublicHttps(w.api)) {
        // e.g. models.dev rows for desktop apps with http://127.0.0.1 endpoints: Omnipus would reject
        // the whole document for one such URL (FR-033), so the row is published without it.
        tier = "unsupported";
        reason = reason ?? "deployment-url";
        report.auto_unsupported.push({ id: w.id, why: `api ${w.api} is not an https URL on a public host` });
      }
    }
    const api = tier === "unsupported" && w.api && !isPublicHttps(w.api) && locality === "cloud" ? "" : (w.api ?? "");
    if (tier === "unsupported" && !reason) reason = "deployment-url";
    const limits: ResizeLimitsT = resize.providers[w.id] ?? resize.default;
    const row: Provider = {
      id: w.id,
      name: w.name,
      company: w.company ?? w.name,
      api,
      protocol: w.protocol ?? "",
      ...(w.protocols ? { protocols: w.protocols } : {}),
      env: w.env ?? [],
      ...(w.region ? { region: w.region } : {}),
      ...(w.plan ? { plan: w.plan } : {}),
      tier,
      ...(tier === "unsupported" ? { unsupported_reason: reason } : {}),
      auth_methods: w.auth_methods ?? ["api_key"],
      aliases: w.aliases ?? [],
      ...(w.cli_kind ? { cli_kind: w.cli_kind } : {}),
      ...(w.token_source ? { token_source: w.token_source } : {}),
      resize_limits: { ...limits },
      models: [...w.models].sort((a, b) => a.id.localeCompare(b.id)),
    };
    out.push(row);
  }
  return { providers: out, report };
}
