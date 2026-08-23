// Normalisation of the two registries into one intermediate shape. models.dev
// is the primary source (provider identity, model list, limits, modalities);
// LiteLLM only supplies numbers/flags to cross-check against it.
import type { Modality, Protocol } from "./schema.js";
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
} {
  const providers: NormalisedProvider[] = [];
  const skipped: SkippedModel[] = [];
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
  return { providers, skipped, unknownNpm: [...unknownNpm].sort() };
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
