// Fetchers for the two upstream registries. Each fetch records the exact bytes
// consumed (sha256 + size), the HTTP ETag, the upstream git commit when the
// GitHub API can tell us, and the fetch time. Nothing else is fetched — in
// particular OpenRouter is never a source (its terms forbid copying).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SourceRecord } from "./schema.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_REPO = "sst/models.dev";
export const MODELS_DEV_BRANCH = "dev";
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const LITELLM_REPO = "BerriAI/litellm";
export const LITELLM_PATH = "model_prices_and_context_window.json";

export type Fetched = { record: SourceRecord; json: unknown; /** the exact upstream bytes the record's sha256 covers */ bytes: Uint8Array };

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function httpGetBytes(url: string): Promise<{ bytes: Uint8Array; etag: string | null }> {
  const res = await fetch(url, { headers: { "user-agent": "omnipus-provider-catalog assembler" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, etag: res.headers.get("etag") };
}

/** Latest commit touching `filePath` (or the branch head when no path) via the GitHub API; null on any failure. */
export async function latestCommit(repo: string, ref: string, filePath?: string): Promise<string | null> {
  const qs = new URLSearchParams({ sha: ref, per_page: "1" });
  if (filePath) qs.set("path", filePath);
  const url = `https://api.github.com/repos/${repo}/commits?${qs.toString()}`;
  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "omnipus-provider-catalog assembler",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ sha?: string }>;
    const sha = body[0]?.sha;
    return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function record(
  name: string,
  url: string,
  license: string,
  bytes: Uint8Array,
  etag: string | null,
  commit: string | null,
  fetchedAt: Date,
): SourceRecord {
  return {
    name,
    url,
    license,
    fetched_at: fetchedAt.toISOString(),
    commit,
    etag,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
}

export async function fetchModelsDev(now = new Date()): Promise<Fetched> {
  const { bytes, etag } = await httpGetBytes(MODELS_DEV_URL);
  // api.json is generated from the `dev` branch on a schedule; the branch head
  // at fetch time is the closest commit id we can record (it may be newer than
  // the commit the published api.json was built from).
  const commit = await latestCommit(MODELS_DEV_REPO, MODELS_DEV_BRANCH);
  return {
    record: record("models.dev", MODELS_DEV_URL, "MIT", bytes, etag, commit, now),
    json: JSON.parse(Buffer.from(bytes).toString("utf8")),
    bytes,
  };
}

export async function fetchLiteLLM(now = new Date()): Promise<Fetched> {
  const { bytes, etag } = await httpGetBytes(LITELLM_URL);
  const commit = await latestCommit(LITELLM_REPO, "main", LITELLM_PATH);
  return {
    record: record("litellm", LITELLM_URL, "MIT", bytes, etag, commit, now),
    json: JSON.parse(Buffer.from(bytes).toString("utf8")),
    bytes,
  };
}

/** Write the raw upstream bytes and their records into a cache directory so a run is reproducible offline. */
export async function cacheFetched(dir: string, name: string, f: Fetched): Promise<void> {
  await mkdir(dir, { recursive: true });
  // The raw bytes, not a re-serialisation: the cached file must hash to record.sha256.
  await writeFile(path.join(dir, `${name}.json`), f.bytes);
  await writeFile(path.join(dir, `${name}.record.json`), JSON.stringify(f.record, null, 2) + "\n");
}

export async function readCached(dir: string, name: string): Promise<Fetched> {
  const bytes = new Uint8Array(await readFile(path.join(dir, `${name}.json`)));
  const record = JSON.parse(await readFile(path.join(dir, `${name}.record.json`), "utf8")) as SourceRecord;
  const actual = sha256Hex(bytes);
  if (actual !== record.sha256) throw new Error(`cached ${name}.json sha256 ${actual} does not match its record ${record.sha256}`);
  return { json: JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown, record, bytes };
}
