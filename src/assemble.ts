// Orchestration: fetch (or read cache) → normalise → merge → overrides →
// carry forward → finalise → validate → write dist/.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { carryForward } from "./carry.js";
import { cacheFetched, fetchLiteLLM, fetchModelsDev, readCached, sha256Hex, type Fetched } from "./fetch.js";
import { finalizeProviders, loadResizeLimits } from "./finalize.js";
import { mergeRegistries } from "./merge.js";
import { applyOverrides, loadOverrides, type WorkingProvider } from "./overrides.js";
import { Catalog as CatalogSchema, SCHEMA_VERSION, type Catalog } from "./schema.js";
import { indexLiteLLM, normaliseModelsDev, type LiteLLMJson, type ModelsDevApi } from "./sources.js";
import { serialiseWithinCap, validateCatalog, type Finding } from "./validate.js";
import { nextVersion } from "./version.js";

const execFileP = promisify(execFile);

export type AssembleOptions = {
  repoRoot: string;
  outDir: string;
  cacheDir: string;
  /** Use the cached upstream files instead of fetching. */
  offline: boolean;
  /** Path of the previously published document (last known good); null = none. */
  previous: string | null;
  now: Date;
};

export class ValidationError extends Error {
  constructor(public findings: Finding[]) {
    super(`document failed validation with ${findings.length} finding(s)`);
  }
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function loadPrevious(file: string | null): Promise<Catalog | null> {
  if (!file) return null;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = CatalogSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`previous document ${file} is not a valid 2.0.0 catalog: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export async function assemble(opts: AssembleOptions): Promise<{ catalog: Catalog; manifest: Record<string, unknown>; json: string }> {
  const { repoRoot, outDir, cacheDir, now } = opts;

  let md: Fetched;
  let ll: Fetched;
  if (opts.offline) {
    md = await readCached(cacheDir, "models.dev");
    ll = await readCached(cacheDir, "litellm");
  } else {
    [md, ll] = await Promise.all([fetchModelsDev(now), fetchLiteLLM(now)]);
    await cacheFetched(cacheDir, "models.dev", md);
    await cacheFetched(cacheDir, "litellm", ll);
  }

  const previous = await loadPrevious(opts.previous);
  const overrides = await loadOverrides(path.join(repoRoot, "overrides"));
  const resize = await loadResizeLimits(path.join(repoRoot, "resize_limits.json"));
  const overridesCommit = await gitHead(repoRoot);

  const normalised = normaliseModelsDev(md.json as ModelsDevApi);
  const litellmIndex = indexLiteLLM(ll.json as LiteLLMJson);
  const merged = mergeRegistries(normalised.providers, litellmIndex, previous);
  // Overrides first (local rows are created here), then carry-forward, so a
  // local-file provider is never mistaken for one that vanished upstream.
  const overridden = applyOverrides(merged.providers as WorkingProvider[], overrides, merged.report.disputes, merged.providers);
  const carried = carryForward(overridden.providers, previous);
  const finalised = finalizeProviders(carried.providers, resize);

  const version = nextVersion(now, previous?.version ?? null);
  const stamp = now.toISOString();
  const source = [
    `models.dev@${md.record.commit ?? "sha256:" + md.record.sha256}`,
    `litellm@${ll.record.commit ?? "sha256:" + ll.record.sha256}`,
    `overrides@${overridesCommit ?? "unknown"}`,
  ].join(" ");

  const catalog: Catalog = {
    schema_version: SCHEMA_VERSION,
    version,
    updated_at: stamp,
    generated_at: stamp,
    source,
    sources: {
      models_dev: md.record,
      litellm: ll.record,
      overrides_commit: overridesCommit,
      previous_version: previous?.version ?? null,
    },
    default_resize_limits: { ...resize.default },
    providers: finalised.providers,
  };

  const { json, trimmed_retired } = serialiseWithinCap(catalog);
  const findings = validateCatalog(JSON.parse(json), { previousVersion: previous?.version ?? null, bytes: Buffer.byteLength(json) });
  if (findings.length > 0) throw new ValidationError(findings);

  const manifest = {
    version,
    generated_at: stamp,
    sources: catalog.sources,
    counts: {
      providers: catalog.providers.length,
      models: catalog.providers.reduce((a, p) => a + p.models.length, 0),
      models_dev_providers: normalised.providers.length,
      litellm_cross_checked: merged.report.cross_checked,
      disputes_open: overridden.disputes.length,
      retired_models_trimmed_for_size: trimmed_retired,
    },
    models_dev_unknown_npm: normalised.unknownNpm,
    models_dev_skipped_models: normalised.skipped,
    skipped_no_context_window: merged.report.skipped_no_window,
    disputes: overridden.disputes,
    within_tolerance: merged.report.within_tolerance,
    filled_from_litellm: merged.report.filled_from_litellm,
    carry_forward: carried.report,
    overrides: overridden.report,
    auto_unsupported: finalised.report.auto_unsupported,
  };

  await mkdir(outDir, { recursive: true });
  const assetName = "providers_catalog.json";
  await writeFile(path.join(outDir, assetName), json);
  await writeFile(path.join(outDir, `${assetName}.sha256`), `${sha256Hex(json)}  ${assetName}\n`);
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { catalog, manifest, json };
}
