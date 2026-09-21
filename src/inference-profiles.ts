// AWS Bedrock cross-Region inference profile fold. models.dev lists each
// region-prefixed inference-profile variant of a Bedrock model as its own
// row (`eu.anthropic.claude-sonnet-4-6` beside `anthropic.claude-sonnet-4-6`).
// The catalog publishes ONE row per base model: the region groups a
// cross-Region inference profile exists for are folded into that base
// model's `inference_profiles`, and the prefixed duplicates are dropped.
// Contract: bedrock-region/CONTRACT.md (shared with the omnipus consumer repo).
//
// Only a KNOWN group prefix (schema.CROSS_REGION_GROUPS: us, eu, apac, jp, au,
// global) is folded. A prefix AWS has not published as a cross-Region inference
// geography (models.dev has been observed to carry `ca.` and `in.` ids that
// are NOT documented AWS geographies — see the report for sources) is left as
// its own standalone model, per "do not guess a group" in the contract.
import type { Model } from "./schema.js";
import { CROSS_REGION_GROUPS, type CrossRegionGroup } from "./schema.js";

const GROUP_RANK = new Map<CrossRegionGroup, number>(CROSS_REGION_GROUPS.map((g, i) => [g, i]));

/**
 * The trailing regional marker models.dev appends to a Bedrock variant's
 * display name (observed: "Nova Premier (US)", "Claude Sonnet 4 (APAC)").
 * Only meaningful for the SAME group as the id prefix that was stripped —
 * a variant's own marker always matches its own prefix, so no guessing is
 * involved: this is a straight, keyed lookup, never a heuristic strip of
 * "any parenthetical".
 */
const GROUP_NAME_MARKER: Record<CrossRegionGroup, string> = {
  us: " (US)",
  eu: " (EU)",
  apac: " (APAC)",
  jp: " (JP)",
  au: " (AU)",
  global: " (Global)",
};

/** The known group prefix `id` starts with (`"eu."` etc.), or null when it has none. `arn:`-style ids never match. */
function matchGroup(id: string): CrossRegionGroup | null {
  if (id.startsWith("arn:")) return null;
  for (const g of CROSS_REGION_GROUPS) {
    if (id.startsWith(`${g}.`)) return g;
  }
  return null;
}

function sortGroups(groups: Iterable<CrossRegionGroup>): CrossRegionGroup[] {
  return [...groups].sort((a, b) => GROUP_RANK.get(a)! - GROUP_RANK.get(b)!);
}

/** Strip the regional name marker for `group` from the end of `name`, if present. A base model must never carry one variant's regional label. */
function stripRegionalMarker(name: string, group: CrossRegionGroup): string {
  const marker = GROUP_NAME_MARKER[group];
  return name.endsWith(marker) ? name.slice(0, -marker.length) : name;
}

/**
 * Fold region-prefixed inference-profile variants into their base model.
 *
 * - A model whose id starts with a known group prefix is dropped from the
 *   output; its group is added to the base model's `inference_profiles`.
 * - When a bare (unprefixed) id exists upstream, that row becomes the base
 *   and keeps its own fields — only `inference_profiles` is added.
 * - When only prefixed variants exist for a base id, the base entry is
 *   synthesised from the first variant encountered (stable input order),
 *   with that variant's own trailing regional name marker (e.g. " (US)")
 *   stripped — a base model must never carry the label of whichever single
 *   region happened to be picked.
 * - `arn:`-style ids and ids with no known group prefix pass through
 *   unchanged, never treated as a variant.
 */
export function foldInferenceProfiles(models: Model[]): Model[] {
  const groupsByBaseId = new Map<string, Set<CrossRegionGroup>>();
  const firstVariantByBaseId = new Map<string, { model: Model; group: CrossRegionGroup }>();
  const standalone: Model[] = [];

  for (const m of models) {
    const group = matchGroup(m.id);
    if (!group) {
      standalone.push(m);
      continue;
    }
    const baseId = m.id.slice(group.length + 1);
    let groups = groupsByBaseId.get(baseId);
    if (!groups) {
      groups = new Set();
      groupsByBaseId.set(baseId, groups);
    }
    groups.add(group);
    if (!firstVariantByBaseId.has(baseId)) firstVariantByBaseId.set(baseId, { model: m, group });
  }

  const consumedBaseIds = new Set<string>();
  const out: Model[] = standalone.map((m) => {
    const groups = groupsByBaseId.get(m.id);
    if (!groups) return m;
    consumedBaseIds.add(m.id);
    return { ...m, inference_profiles: sortGroups(groups) };
  });

  for (const [baseId, groups] of groupsByBaseId) {
    if (consumedBaseIds.has(baseId)) continue;
    const { model: variant, group } = firstVariantByBaseId.get(baseId)!;
    out.push({ ...variant, id: baseId, name: stripRegionalMarker(variant.name, group), inference_profiles: sortGroups(groups) });
  }

  return out;
}
