import { VERSION_RE } from "./schema.js";

/** Parse `vYYYY.M.D[.N]` into numeric parts; throws on a malformed value. */
export function parseVersion(v: string): number[] {
  if (!VERSION_RE.test(v)) throw new Error(`version ${JSON.stringify(v)} does not match vYYYY.M.D[.N]`);
  return v
    .slice(1)
    .split(".")
    .map((p) => Number(p));
}

/** Numeric compare: negative when a < b, 0 when equal, positive when a > b. A missing `.N` counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 4; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Next release version for `now` (UTC date), strictly greater than `previous`.
 * Same calendar day as the previous release → bump `.N`. A previous version
 * dated in the future (clock skew) is still bumped rather than regressed.
 */
export function nextVersion(now: Date, previous: string | null): string {
  const today = `v${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
  if (previous === null) return today;
  const cmp = compareVersions(today, previous);
  if (cmp > 0) return today;
  const parts = parseVersion(previous);
  const n = (parts[3] ?? 0) + 1;
  return `v${parts[0]}.${parts[1]}.${parts[2]}.${n}`;
}
