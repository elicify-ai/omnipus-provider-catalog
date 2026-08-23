#!/usr/bin/env node
// Render the body of the "registry disagreement" issue from dist/manifest.json.
// Usage: node scripts/dispute-issue-body.mjs dist/manifest.json
// Prints nothing and exits 0 when there are no disputes (caller skips the issue).
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "dist/manifest.json";
const m = JSON.parse(readFileSync(file, "utf8"));
const disputes = m.disputes ?? [];
if (disputes.length === 0) process.exit(0);

const MAX = 300;
const rows = disputes.slice(0, MAX).map(
  (d) => `| ${d.provider} | ${d.model} | ${d.field} | ${d.models_dev} | ${d.litellm} | ${d.published}${d.last_known_good ? " (last known good)" : ""} | \`${d.litellm_key ?? ""}\` |`,
);
const out = [
  `Assembly run for **${m.version}** (generated ${m.generated_at}) found **${disputes.length}** registry disagreement(s) above the tolerance (> 5 % and > 4,096 tokens, or a boolean/enum difference).`,
  "",
  "The release was **not** blocked: each row publishes the last-known-good value (models.dev's when there is none) and carries `disputed: true`. Resolve by adding an entry under `overrides/` or by confirming the upstream fix, then close.",
  "",
  `Sources: models.dev \`${m.sources?.models_dev?.commit ?? "?"}\`, LiteLLM \`${m.sources?.litellm?.commit ?? "?"}\`.`,
  "",
  "| provider | model | field | models.dev | LiteLLM | published | LiteLLM key |",
  "|---|---|---|---|---|---|---|",
  ...rows,
];
if (disputes.length > MAX) out.push("", `… ${disputes.length - MAX} more in the run's \`manifest.json\` artifact.`);
process.stdout.write(out.join("\n") + "\n");
