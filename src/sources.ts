// Normalisation of the two registries into one intermediate shape. models.dev
// is the primary source (provider identity, model list, limits, modalities);
// LiteLLM only supplies numbers/flags to cross-check against it.
import type { CostTier, Modality, ModelCost, Protocol } from "./schema.js";
import { MODALITIES } from "./schema.js";

// ---------- models.dev ----------

/** The subset of models.dev's api.json shape we read (packages/core/src/schema.ts in sst/models.dev). */
export type ModelsDevModel = {
  id: string;
  name: string;
  tool_call?: boolean;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  status?: string;
  /**
   * models.dev prices are already USD per 1 million tokens. Audio prices are
   * read so a fixture can carry them, and then dropped: they are not published.
   */
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    cache_write_1h?: number;
    input_audio?: number;
    output_audio?: number;
    context_over_200k?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache_read?: number;
      cache_write?: number;
      cache_write_1h?: number;
    };
    tiers?: Array<{
      input?: number;
      output?: number;
      reasoning?: number;
      cache_read?: number;
      cache_write?: number;
      cache_write_1h?: number;
      tier?: { type?: string; size?: number; boundary?: string };
    }>;
  };
};
export type ModelsDevProvider = {
  id: string;
  name: string;
  npm: string;
  api?: string;
  env?: string[];
  doc?: string;
  models: Record<string, ModelsDevModel>;
};
export type ModelsDevApi = Record<string, ModelsDevProvider>;

/**
 * models.dev `npm` → Omnipus protocol. Dedicated SDKs that are OpenAI-compatible
 * on the wire map to openai-compatible; their base URL comes from overrides/
 * because models.dev records none for them. Cloud-IAM / deployment SDKs map to
 * null (no protocol Omnipus can speak) and become tier unsupported.
 */
export const NPM_TO_PROTOCOL: Record<string, Protocol | null> = {
  "@ai-sdk/openai-compatible": "openai-compatible",
  "@ai-sdk/openai": "openai-compatible",
  "@openrouter/ai-sdk-provider": "openai-compatible",
  "@ai-sdk/xai": "openai-compatible",
  "@ai-sdk/groq": "openai-compatible",
  "@ai-sdk/mistral": "openai-compatible",
  "@ai-sdk/cerebras": "openai-compatible",
  "@ai-sdk/togetherai": "openai-compatible",
  "@ai-sdk/deepinfra": "openai-compatible",
  "@ai-sdk/perplexity": "openai-compatible",
  "@ai-sdk/cohere": "openai-compatible",
  "@ai-sdk/vercel": "openai-compatible",
  "@ai-sdk/gateway": "openai-compatible",
  "merge-gateway-ai-sdk-provider": "openai-compatible",
  "venice-ai-sdk-provider": "openai-compatible",
  "@aihubmix/ai-sdk-provider": "openai-compatible",
  "ai-gateway-provider": "openai-compatible",
  "@qvac/ai-sdk-provider": "openai-compatible",
  "@saladtechnologies-oss/ai-sdk-provider": "openai-compatible",
  "gitlab-ai-provider": "openai-compatible",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "google",
  "@ai-sdk/google-vertex": null,
  "@ai-sdk/google-vertex/anthropic": null,
  "@ai-sdk/amazon-bedrock": null,
  "@ai-sdk/azure": null,
  "watsonx-ai-provider": null,
  "@jerome-benoit/sap-ai-provider-v2": null,
};

export function protocolForNpm(npm: string): Protocol | null | undefined {
  return NPM_TO_PROTOCOL[npm];
}

export type NormalisedModel = {
  id: string;
  name: string;
  release_date?: string;
  tool_call: boolean;
  context_window: number;
  max_output_tokens: number;
  input_modalities: Modality[];
  /** Absent when models.dev published no usable price. Never a bag of zeros. */
  cost?: ModelCost;
};
export type NormalisedProvider = {
  id: string;
  name: string;
  npm: string;
  api: string;
  /** true when models.dev's api contains a `${VAR}` placeholder (deployment-specific). */
  api_is_template: boolean;
  protocol: Protocol | "";
  env: string[];
  models: NormalisedModel[];
};

export type SkippedModel = { provider: string; model: string; reason: string };
/** A models.dev cost object we refused to publish. The model itself is still published, without a price. */
export type CostRejected = { provider: string; model: string; reason: string };

const PRICE_KEYS = ["input", "output", "reasoning", "cache_read", "cache_write", "cache_write_1h"] as const;
type PriceKey = (typeof PRICE_KEYS)[number];

function finitePrice(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Copy the price fields. A present value that is not a finite number >= 0
 * rejects the whole cost: dropping only that field would make "absent"
 * (priced at the input rate) out of a value the source did publish.
 */
function readPriceFields(
  raw: Record<string, unknown>,
  where: string,
): { prices: Partial<Record<PriceKey, number>>; reason?: string } {
  const prices: Partial<Record<PriceKey, number>> = {};
  for (const key of PRICE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined) continue;
    const n = finitePrice(raw[key]);
    if (n === undefined) {
      return { prices: {}, reason: `${where}.${key} is not a finite number >= 0; the model is published without a price` };
    }
    prices[key] = n;
  }
  return { prices };
}

function pricesToCost(prices: Partial<Record<PriceKey, number>>, where: string): { cost?: ModelCost; reason?: string } {
  if (prices.input === undefined) return { reason: `${where}.input is missing; the model is published without a price` };
  if (prices.output === undefined) return { reason: `${where}.output is missing; the model is published without a price` };
  const cost: ModelCost = { input: prices.input, output: prices.output };
  for (const key of ["reasoning", "cache_read", "cache_write", "cache_write_1h"] as const) {
    if (prices[key] !== undefined) cost[key] = prices[key];
  }
  return { cost };
}

/** models.dev `cost` → the published shape. `reason` set means "publish the model with no price". */
export function readModelCost(raw: unknown): { cost?: ModelCost; reason?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { reason: "cost is not an object; the model is published without a price" };
  }
  const obj = raw as Record<string, unknown>;
  const base = readPriceFields(obj, "cost");
  if (base.reason) return { reason: base.reason };
  const built = pricesToCost(base.prices, "cost");
  if (built.reason || !built.cost) return { reason: built.reason };
  const cost = built.cost;

  if (Object.prototype.hasOwnProperty.call(obj, "context_over_200k") && obj.context_over_200k !== undefined) {
    const legacy = obj.context_over_200k;
    if (typeof legacy !== "object" || legacy === null || Array.isArray(legacy)) {
      return { reason: "cost.context_over_200k is not an object; the model is published without a price" };
    }
    const parsed = readPriceFields(legacy as Record<string, unknown>, "cost.context_over_200k");
    if (parsed.reason) return { reason: parsed.reason };
    const legacyCost = pricesToCost(parsed.prices, "cost.context_over_200k");
    if (legacyCost.reason || !legacyCost.cost) return { reason: legacyCost.reason };
    cost.context_over_200k = legacyCost.cost;
  }

  if (Object.prototype.hasOwnProperty.call(obj, "tiers") && obj.tiers !== undefined) {
    if (!Array.isArray(obj.tiers)) return { reason: "cost.tiers is not an array; the model is published without a price" };
    const tiers: CostTier[] = [];
    for (let i = 0; i < obj.tiers.length; i++) {
      const tierRaw = obj.tiers[i];
      const where = `cost.tiers[${i}]`;
      if (typeof tierRaw !== "object" || tierRaw === null || Array.isArray(tierRaw)) {
        return { reason: `${where} is not an object; the model is published without a price` };
      }
      const t = tierRaw as Record<string, unknown>;
      const prices = readPriceFields(t, where);
      if (prices.reason) return { reason: prices.reason };
      const tierPrices = pricesToCost(prices.prices, where);
      if (tierPrices.reason || !tierPrices.cost) return { reason: tierPrices.reason };
      const meta = t.tier;
      if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
        return { reason: `${where}.tier is not an object; the model is published without a price` };
      }
      const tierMeta = meta as Record<string, unknown>;
      if (tierMeta.type !== "context") {
        return { reason: `${where}.tier.type is not "context"; the model is published without a price` };
      }
      if (typeof tierMeta.size !== "number" || !Number.isInteger(tierMeta.size) || tierMeta.size < 0) {
        return { reason: `${where}.tier.size is not an integer >= 0; the model is published without a price` };
      }
      const tier: CostTier = {
        input: tierPrices.cost.input,
        output: tierPrices.cost.output,
        tier: { type: "context", size: tierMeta.size },
      };
      for (const key of ["reasoning", "cache_read", "cache_write", "cache_write_1h"] as const) {
        if (tierPrices.cost[key] !== undefined) tier[key] = tierPrices.cost[key];
      }
      if (Object.prototype.hasOwnProperty.call(tierMeta, "boundary") && tierMeta.boundary !== undefined) {
        if (tierMeta.boundary !== "above" && tierMeta.boundary !== "at_least") {
          return { reason: `${where}.tier.boundary is not "above" or "at_least"; the model is published without a price` };
        }
        tier.tier.boundary = tierMeta.boundary;
      }
      tiers.push(tier);
    }
    cost.tiers = tiers;
  }
  return { cost };
}

function toModalities(input: string[] | undefined): Modality[] | null {
  if (!input) return null;
  const out: Modality[] = [];
  for (const m of input) {
    if ((MODALITIES as readonly string[]).includes(m) && !out.includes(m as Modality)) out.push(m as Modality);
  }
  return out;
}

export function normaliseModelsDev(api: ModelsDevApi): {
  providers: NormalisedProvider[];
  skipped: SkippedModel[];
  unknownNpm: string[];
  cost_rejected: CostRejected[];
} {
  const providers: NormalisedProvider[] = [];
  const skipped: SkippedModel[] = [];
  const costRejected: CostRejected[] = [];
  const unknownNpm = new Set<string>();
  for (const pid of Object.keys(api).sort()) {
    const p = api[pid]!;
    const mapped = protocolForNpm(p.npm);
    if (mapped === undefined) unknownNpm.add(p.npm);
    const rawApi = (p.api ?? "").trim();
    const template = rawApi.includes("${");
    const models: NormalisedModel[] = [];
    for (const mid of Object.keys(p.models ?? {}).sort()) {
      const m = p.models[mid]!;
      const mods = toModalities(m.modalities?.input);
      if (!mods || !mods.includes("text")) {
        skipped.push({ provider: pid, model: mid, reason: "input modalities do not include text" });
        continue;
      }
      // Image / video / audio generators and other non-text-producing models are
      // not chat models: they have no context window and cannot be driven by
      // the agent loop, so they are not catalog rows. (An absent output list is
      // treated as text: models.dev's schema defaults it.)
      const outputs = m.modalities?.output;
      if (Array.isArray(outputs) && !outputs.includes("text")) {
        skipped.push({ provider: pid, model: mid, reason: `output modalities ${JSON.stringify(outputs)} do not include text` });
        continue;
      }
      const nm: NormalisedModel = {
        id: mid,
        name: m.name || mid,
        tool_call: m.tool_call === true,
        context_window: Math.max(0, Math.floor(m.limit?.context ?? 0)),
        max_output_tokens: Math.max(0, Math.floor(m.limit?.output ?? 0)),
        input_modalities: mods,
      };
      if (m.release_date && /^\d{4}-\d{2}-\d{2}$/.test(m.release_date)) nm.release_date = m.release_date;
      const read = readModelCost(m.cost);
      if (read.reason) costRejected.push({ provider: pid, model: mid, reason: read.reason });
      else if (read.cost) nm.cost = read.cost;
      models.push(nm);
    }
    providers.push({
      id: pid,
      name: p.name || pid,
      npm: p.npm,
      api: template ? "" : rawApi,
      api_is_template: template,
      protocol: mapped ?? "",
      env: Array.isArray(p.env) ? p.env.filter((e) => typeof e === "string") : [],
      models,
    });
  }
  return { providers, skipped, unknownNpm: [...unknownNpm].sort(), cost_rejected: costRejected };
}

// ---------- LiteLLM ----------

export type LiteLLMEntry = {
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_pdf_input?: boolean;
  supports_audio_input?: boolean;
  supported_modalities?: string[];
  /** USD per token. Standard rates only — batch, flex and priority are different products and are not read. */
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  output_cost_per_reasoning_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  input_cost_per_token_batches?: number;
  output_cost_per_token_batches?: number;
};
export type LiteLLMJson = Record<string, LiteLLMEntry>;

/** What LiteLLM explicitly says about a model; `undefined` means "LiteLLM carries no information". */
export type LiteLLMFacts = {
  key: string;
  context_window?: number;
  max_output_tokens?: number;
  tool_call?: boolean;
  /** Per-modality explicit statements; modalities LiteLLM is silent on are absent. */
  modalities?: Partial<Record<Exclude<Modality, "text">, boolean>>;
  /**
   * USD per 1 million tokens, converted from LiteLLM's per-token fields.
   * A key is present only when LiteLLM published that price, including a real 0.
   */
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    cache_write_1h?: number;
  };
};

/**
 * models.dev provider id → LiteLLM `litellm_provider` values whose rows describe
 * the same route. Only providers with a sound correspondence are listed; a
 * provider absent here is simply not cross-checked.
 */
export const LITELLM_PROVIDER_MAP: Record<string, string[]> = {
  openai: ["openai"],
  anthropic: ["anthropic"],
  google: ["gemini"],
  xai: ["xai"],
  groq: ["groq"],
  mistral: ["mistral"],
  deepseek: ["deepseek"],
  openrouter: ["openrouter"],
  cerebras: ["cerebras"],
  togetherai: ["together_ai"],
  deepinfra: ["deepinfra"],
  perplexity: ["perplexity"],
  cohere: ["cohere_chat", "cohere"],
  moonshotai: ["moonshot"],
  zai: ["zai"],
  minimax: ["minimax"],
  "fireworks-ai": ["fireworks_ai"],
  "github-copilot": ["github_copilot"],
  "openai-chatgpt": ["chatgpt"],
  volcengine: ["volcengine"],
  nvidia: ["nvidia_nim"],
  ollama: ["ollama"],
  "novita-ai": ["novita"],
  sambanova: ["sambanova"],
  nebius: ["nebius"],
  hyperbolic: ["hyperbolic"],
  scaleway: ["scaleway"],
  ovhcloud: ["ovhcloud"],
  "alibaba-cn": ["dashscope"],
  alibaba: ["dashscope"],
  lambda: ["lambda_ai"],
  crusoe: ["crusoe"],
  baseten: ["baseten"],
  wandb: ["wandb"],
  amazon: ["amazon_nova"],
};

const CHAT_MODES = new Set(["chat", "responses"]);

/**
 * LiteLLM publishes USD per token. The catalog publishes USD per 1 million
 * tokens. Round to 6 decimal places: that is the finest models.dev price, and
 * it removes binary dust such as `1e-7 * 1e6` → `0.0999…` instead of `0.1`.
 * This is not the 4,096 absolute tolerance; that tolerance is never applied
 * to dollars.
 */
export function perTokenToPerMillion(perToken: number): number {
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6;
}

const LITELLM_PRICE_FIELDS = {
  input: "input_cost_per_token",
  output: "output_cost_per_token",
  reasoning: "output_cost_per_reasoning_token",
  cache_read: "cache_read_input_token_cost",
  cache_write: "cache_creation_input_token_cost",
  cache_write_1h: "cache_creation_input_token_cost_above_1hr",
} as const;

function litellmCost(e: LiteLLMEntry): LiteLLMFacts["cost"] | undefined {
  const cost: NonNullable<LiteLLMFacts["cost"]> = {};
  let any = false;
  for (const [ours, theirs] of Object.entries(LITELLM_PRICE_FIELDS) as [keyof NonNullable<LiteLLMFacts["cost"]>, keyof LiteLLMEntry][]) {
    const v = e[theirs];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    cost[ours] = perTokenToPerMillion(v);
    any = true;
  }
  return any ? cost : undefined;
}

/** Index LiteLLM rows by `${litellm_provider}|${bare model id}`. */
export function indexLiteLLM(json: LiteLLMJson): Map<string, LiteLLMFacts> {
  const index = new Map<string, LiteLLMFacts>();
  for (const [key, e] of Object.entries(json)) {
    if (!e || typeof e !== "object") continue;
    const lp = e.litellm_provider;
    if (typeof lp !== "string" || !lp) continue;
    if (e.mode !== undefined && !CHAT_MODES.has(e.mode)) continue;
    const facts: LiteLLMFacts = { key };
    if (typeof e.max_input_tokens === "number" && e.max_input_tokens > 0) facts.context_window = Math.floor(e.max_input_tokens);
    if (typeof e.max_output_tokens === "number" && e.max_output_tokens > 0) facts.max_output_tokens = Math.floor(e.max_output_tokens);
    if (typeof e.supports_function_calling === "boolean") facts.tool_call = e.supports_function_calling;
    const mods: LiteLLMFacts["modalities"] = {};
    if (Array.isArray(e.supported_modalities)) {
      const set = new Set(e.supported_modalities);
      mods.image = set.has("image");
      mods.audio = set.has("audio");
      mods.video = set.has("video");
    }
    if (typeof e.supports_vision === "boolean") mods.image = e.supports_vision;
    if (typeof e.supports_audio_input === "boolean") mods.audio = e.supports_audio_input;
    if (typeof e.supports_pdf_input === "boolean") mods.pdf = e.supports_pdf_input;
    if (Object.keys(mods).length > 0) facts.modalities = mods;

    const cost = litellmCost(e);
    if (cost) facts.cost = cost;

    const bare = stripProviderPrefix(key, lp);
    for (const k of new Set([`${lp}|${key}`, `${lp}|${bare}`])) {
      if (!index.has(k)) index.set(k, facts);
    }
  }
  return index;
}

/** `gemini/gemini-2.5-flash` → `gemini-2.5-flash`; `openrouter/z-ai/glm-4.5` → `z-ai/glm-4.5`; bare keys unchanged. */
export function stripProviderPrefix(key: string, litellmProvider: string): string {
  const slash = key.indexOf("/");
  if (slash <= 0) return key;
  const head = key.slice(0, slash);
  const norm = (s: string) => s.toLowerCase().replace(/-/g, "_");
  const lp = norm(litellmProvider);
  if (norm(head) === lp || lp.startsWith(norm(head) + "_")) return key.slice(slash + 1);
  return key;
}

export function lookupLiteLLM(index: Map<string, LiteLLMFacts>, providerId: string, modelId: string): LiteLLMFacts | undefined {
  const lps = LITELLM_PROVIDER_MAP[providerId];
  if (!lps) return undefined;
  for (const lp of lps) {
    const hit = index.get(`${lp}|${modelId}`);
    if (hit) return hit;
  }
  return undefined;
}
