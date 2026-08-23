// The 2.0.0 catalog document. docs/schema-2.0.0.md is the prose reference for
// the same shape; this file is the authority.
//
// Two top-level fields are informational companions of others; both are additive:
//   - `generated_at` mirrors `updated_at`;
//   - `sources` is the structured form of the `source` summary string.
// `locality` is NOT published (consumers derive it on load); the
// assembler derives it the same way internally (src/finalize.ts) to apply the
// https/public-host rule.
import { z } from "zod";

export const SCHEMA_VERSION = "2.0.0" as const;

/** `vYYYY.M.D[.N]` — the leading `v` is required so versions sort numerically. */
export const VERSION_RE = /^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/;

export const PROTOCOLS = ["openai-compatible", "anthropic", "google", "ollama", "cli"] as const;
export const TIERS = ["popular", "standard", "unsupported"] as const;
export const UNSUPPORTED_REASONS = ["cloud-iam", "deployment-url", "withdrawn"] as const;
export const AUTH_METHODS = ["api_key", "sign_in"] as const;
export const CLI_KINDS = ["codex", "copilot"] as const;
export const MODEL_STATUSES = ["active", "retired"] as const;
export const MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;

/** The popular set, pinned by name. */
export const POPULAR_SET = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
  "xai",
  "groq",
  "mistral",
  "deepseek",
] as const;

/** Providers added from overrides/local-providers.yaml that models.dev does not list. */
export const LOCAL_FILE_PROVIDERS = [
  "ollama",
  "vllm",
  "litellm",
  "lmstudio",
  "codex-cli",
  "openai-chatgpt",
  "github-copilot",
  "shengsuanyun",
  "volcengine",
  "avian",
  "mimo",
] as const;

export const ResizeLimits = z
  .object({
    long_edge_px: z.number().int().positive(),
    max_bytes: z.number().int().positive(),
  })
  .strict();
export type ResizeLimits = z.infer<typeof ResizeLimits>;

export const ProtocolEntry = z
  .object({
    protocol: z.enum(PROTOCOLS),
    api: z.string(),
  })
  .strict();
export type ProtocolEntry = z.infer<typeof ProtocolEntry>;

export const Model = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tool_call: z.boolean(),
    context_window: z.number().int().nonnegative(),
    max_output_tokens: z.number().int().nonnegative(),
    input_modalities: z.array(z.enum(MODALITIES)).min(1),
    status: z.enum(MODEL_STATUSES),
    disputed: z.boolean().optional(),
  })
  .strict();
export type Model = z.infer<typeof Model>;

export const Provider = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    company: z.string().min(1),
    api: z.string(),
    // Empty string allowed only when tier is unsupported (checked in validate.ts).
    protocol: z.union([z.enum(PROTOCOLS), z.literal("")]),
    protocols: z.array(ProtocolEntry).optional(),
    env: z.array(z.string()),
    region: z.string().optional(),
    plan: z.string().optional(),
    tier: z.enum(TIERS),
    unsupported_reason: z.enum(UNSUPPORTED_REASONS).optional(),
    auth_methods: z.array(z.enum(AUTH_METHODS)).min(1),
    aliases: z.array(z.string()),
    custom: z.boolean().optional(),
    cli_kind: z.enum(CLI_KINDS).optional(),
    token_source: z.string().optional(),
    resize_limits: ResizeLimits,
    models: z.array(Model),
  })
  .strict();
export type Provider = z.infer<typeof Provider>;

export const SourceRecord = z
  .object({
    name: z.string().min(1),
    url: z.string().min(1),
    license: z.string().min(1),
    fetched_at: z.string().min(1),
    /** Upstream commit id when it could be determined, else null. */
    commit: z.string().nullable(),
    etag: z.string().nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type SourceRecord = z.infer<typeof SourceRecord>;

export const Sources = z
  .object({
    models_dev: SourceRecord,
    litellm: SourceRecord,
    /** Git commit of this repository's overrides/ and resize_limits.json (null when not in git). */
    overrides_commit: z.string().nullable(),
    previous_version: z.string().nullable(),
  })
  .strict();
export type Sources = z.infer<typeof Sources>;

export const Catalog = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    version: z.string().regex(VERSION_RE),
    updated_at: z.string().min(1),
    generated_at: z.string().min(1),
    source: z.string().min(1),
    sources: Sources,
    default_resize_limits: ResizeLimits,
    providers: z.array(Provider).min(1),
  })
  .strict();
export type Catalog = z.infer<typeof Catalog>;

export type Protocol = (typeof PROTOCOLS)[number];
export type Tier = (typeof TIERS)[number];
export type Modality = (typeof MODALITIES)[number];
