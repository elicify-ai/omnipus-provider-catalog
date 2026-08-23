#!/usr/bin/env node
// Usage:
//   npm run fetch                         fetch both registries into .cache/ (no merge)
//   npm run assemble [-- --offline] [--previous <file>] [--out dist] [--date YYYY-MM-DD]
//   npm run validate [-- <file>] [--previous <file>]
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assemble, loadPrevious, ValidationError } from "./assemble.js";
import { cacheFetched, fetchLiteLLM, fetchModelsDev } from "./fetch.js";
import { validateCatalog } from "./validate.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): { cmd: string; flags: Map<string, string | true>; positional: string[] } {
  const [cmd = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else flags.set(key, true);
    } else positional.push(a);
  }
  return { cmd, flags, positional };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(repoRoot, String(flags.get("out") ?? "dist"));
  const cacheDir = path.resolve(repoRoot, ".cache");
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };

  if (cmd === "fetch") {
    const now = new Date();
    const [md, ll] = await Promise.all([fetchModelsDev(now), fetchLiteLLM(now)]);
    await cacheFetched(cacheDir, "models.dev", md);
    await cacheFetched(cacheDir, "litellm", ll);
    console.log(`models.dev  ${md.record.bytes} bytes sha256=${md.record.sha256} commit=${md.record.commit ?? "?"} etag=${md.record.etag ?? "?"}`);
    console.log(`litellm     ${ll.record.bytes} bytes sha256=${ll.record.sha256} commit=${ll.record.commit ?? "?"} etag=${ll.record.etag ?? "?"}`);
    console.log(`cached in ${cacheDir}`);
    return 0;
  }

  if (cmd === "assemble") {
    // Default previous: an existing dist/providers_catalog.json (the last run), else the repo-root raw-fallback copy.
    let previous = str("previous") ?? null;
    if (previous === null && !flags.has("no-previous")) {
      for (const cand of [path.join(outDir, "providers_catalog.json"), path.join(repoRoot, "providers_catalog.json")]) {
        if (await exists(cand)) {
          previous = cand;
          break;
        }
      }
    }
    const dateFlag = str("date");
    const now = dateFlag ? new Date(`${dateFlag}T06:00:00Z`) : new Date();
    try {
      const r = await assemble({ repoRoot, outDir, cacheDir, offline: flags.has("offline"), previous, now });
      const c = r.manifest.counts as Record<string, number>;
      console.log(`wrote ${path.join(outDir, "providers_catalog.json")} (${Buffer.byteLength(r.json)} bytes) version ${r.catalog.version}`);
      console.log(`providers=${c.providers} models=${c.models} cross_checked=${c.litellm_cross_checked} disputes=${c.disputes_open} previous=${previous ?? "none"}`);
      return 0;
    } catch (err) {
      if (err instanceof ValidationError) {
        console.error(err.message);
        for (const f of err.findings) console.error(`  ${f.path}: ${f.message}`);
        return 2;
      }
      throw err;
    }
  }

  if (cmd === "validate") {
    const file = path.resolve(repoRoot, positional[0] ?? path.join(outDir, "providers_catalog.json"));
    const prevFile = str("previous");
    const previous = prevFile ? await loadPrevious(path.resolve(repoRoot, prevFile)) : null;
    const raw = await readFile(file, "utf8");
    const findings = validateCatalog(JSON.parse(raw), { previousVersion: previous?.version ?? null, bytes: Buffer.byteLength(raw) });
    if (findings.length === 0) {
      console.log(`${file}: valid 2.0.0 document (${Buffer.byteLength(raw)} bytes)`);
      return 0;
    }
    console.error(`${file}: ${findings.length} finding(s)`);
    for (const f of findings) console.error(`  ${f.path}: ${f.message}`);
    return 2;
  }

  console.log("commands: fetch | assemble [--offline] [--previous <file>] [--no-previous] [--out <dir>] [--date YYYY-MM-DD] | validate [<file>] [--previous <file>]");
  return cmd === "help" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
