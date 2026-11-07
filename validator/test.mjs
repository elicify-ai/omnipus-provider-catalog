#!/usr/bin/env node
// Self-test: the minimal valid fixture passes every check, and each
// fixtures/invalid/<CHECK>.json fails its own check (and no check the mutation
// cannot legitimately touch). Run: `npm run validate:spec:test`.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocument, CHECKS } from "./validate-spec.mjs";
import { generate } from "../fixtures/gen.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "fixtures");
generate(fixtures); // regenerates the gitignored SIZE fixture too

// Collateral failures that are unavoidable consequences of a mutation, not bugs.
const ALLOWED_COLLATERAL = {
  JSON: "*", // nothing else can be evaluated
  PROVIDERS_MIN: ["POPULAR", "CLOUD_IAM", "LOCAL_FILE_PROVIDERS"],
  PROTOCOL: ["PROTOCOLS_LIST"], // the mirrored protocols[] entry also becomes invalid
  CLOUD_IAM: [],
};

let failures = 0;
const say = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };

const valid = validateDocument(readFileSync(join(fixtures, "valid-minimal.json")));
const validFails = valid.results.filter((r) => !r.ok);
say(validFails.length === 0, `valid-minimal.json passes all ${CHECKS.length} checks` + (validFails.length ? ` — failed: ${validFails.map((r) => `${r.id}(${r.examples[0]})`).join("; ")}` : ""));

const files = readdirSync(join(fixtures, "invalid")).filter((f) => f.endsWith(".json")).sort();
say(files.length === CHECKS.length, `${files.length} invalid fixtures for ${CHECKS.length} checks`);
for (const f of files) {
  const id = f.replace(/\.json$/, "");
  const report = validateDocument(readFileSync(join(fixtures, "invalid", f)));
  const failed = report.results.filter((r) => !r.ok).map((r) => r.id);
  const own = failed.includes(id);
  const allowed = ALLOWED_COLLATERAL[id] ?? [];
  const stray = allowed === "*" ? [] : failed.filter((x) => x !== id && !allowed.includes(x));
  say(own && stray.length === 0, `invalid/${f} fails ${id}` + (own ? "" : " — DID NOT FAIL") + (stray.length ? ` — stray: ${stray.join(",")}` : ""));
}
// max_patches (omnipus#1435): optional; when present a positive integer, on
// the default and on a provider. Absent and 30000 pass; 0, -1, 1.5 and a
// string fail exactly their own check.
const base = () => JSON.parse(readFileSync(join(fixtures, "valid-minimal.json"), "utf8"));
const failedIDs = (doc) => validateDocument(JSON.stringify(doc)).results.filter((r) => !r.ok).map((r) => r.id);
{
  const d = base();
  d.default_resize_limits.max_patches = 30000;
  d.providers[0].resize_limits.max_patches = 30000;
  const failed = failedIDs(d);
  say(failed.length === 0, "max_patches 30000 on the default and a provider passes" + (failed.length ? ` — failed: ${failed.join(",")}` : ""));
}
for (const bad of [0, -1, 1.5, "30000"]) {
  const d = base();
  d.default_resize_limits.max_patches = bad;
  const fd = failedIDs(d);
  say(fd.length === 1 && fd[0] === "DEFAULT_RESIZE", `default max_patches ${JSON.stringify(bad)} fails DEFAULT_RESIZE only (got ${fd.join(",") || "none"})`);
  const p = base();
  p.providers[0].resize_limits.max_patches = bad;
  const fp = failedIDs(p);
  say(fp.length === 1 && fp[0] === "RESIZE_LIMITS", `provider max_patches ${JSON.stringify(bad)} fails RESIZE_LIMITS only (got ${fp.join(",") || "none"})`);
}

console.log(failures ? `\n${failures} self-test failure(s)` : "\nself-test passed");
process.exit(failures ? 1 : 0);
