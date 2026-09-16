// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Caller models for the side-by-side demo and bench lanes: the short family
// names the page offers, the provider model ids each maps to, and which
// families route through OpenRouter rather than the Anthropic API directly.

/** Ordered list for the demo selector (cheapest / familiar first). */
export const CALLER_FAMILIES = [
  "haiku",
  "sonnet",
  "opus",
  "deepseek-flash",
  "kimi-k3",
  "glm-5",
  "gpt-5-sol",
];

/** Human labels for the selector and page title (family id → display name). */
export const CALLER_LABELS = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "kimi-k3": "Kimi K3",
  "glm-5": "GLM 5.3",
  "gpt-5-sol": "GPT 5.6 Sol",
};

export const DEFAULT_CALLER_FAMILY = "sonnet";

const ANTHROPIC_FAMILIES = new Set(["haiku", "sonnet", "opus"]);

/** Default OpenRouter model slugs; override per family with DEMO_MODEL_<FAMILY>. */
const DEFAULT_OPENROUTER_MODELS = {
  "deepseek-flash": "deepseek/deepseek-v4.1-flash",
  "kimi-k3": "moonshotai/kimi-k3",
  "glm-5": "z-ai/glm-4.6",
  "gpt-5-sol": "openai/gpt-5",
};

/** Anthropic models via OpenRouter when there is no direct ANTHROPIC_API_KEY. */
const OPENROUTER_ANTHROPIC_MODELS = {
  haiku: "anthropic/claude-haiku-4.5",
  sonnet: "anthropic/claude-sonnet-4.6",
  opus: "anthropic/claude-opus-4.6",
};

const DEFAULT_ANTHROPIC_MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-5",
};

/** Families that always use OpenRouter (non-Anthropic slugs). */
export const OPENROUTER_ONLY_FAMILIES = new Set(Object.keys(DEFAULT_OPENROUTER_MODELS));

const ENV_FAMILY = (family) =>
  `DEMO_MODEL_${String(family).toUpperCase().replace(/-/g, "_")}`;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Whether OpenRouter credentials are present. */
export function openRouterConfigured(env = process.env) {
  return Boolean(env.OPENROUTER_API_KEY?.trim());
}

function anthropicDirectConfigured(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/** Route Anthropic families through OpenRouter when direct Anthropic is unset. */
export function usesOpenRouterForFamily(family, env = process.env) {
  const key = String(family ?? "").toLowerCase();
  if (OPENROUTER_ONLY_FAMILIES.has(key)) return true;
  if (!ANTHROPIC_FAMILIES.has(key)) return false;
  if (env.DEMO_CALLER_OPENROUTER === "0") return false;
  if (env.DEMO_CALLER_OPENROUTER === "1") {
    if (anthropicDirectConfigured(env) && ANTHROPIC_FAMILIES.has(key)) return false;
    return openRouterConfigured(env);
  }
  return openRouterConfigured(env) && !anthropicDirectConfigured(env);
}

/** OpenRouter-only picker families use the HTTP chat runner, not Claude Code. */
export function openRouterOuterCaller(family, env = process.env) {
  const key = String(family ?? "").toLowerCase();
  return OPENROUTER_ONLY_FAMILIES.has(key) && openRouterConfigured(env);
}

/** Build the full map from env overrides + defaults (evaluated at call time). */
export function resolveCallerModels(env = process.env) {
  const out = {};
  for (const family of CALLER_FAMILIES) {
    const fromEnv = env[ENV_FAMILY(family)];
    if (fromEnv !== undefined && fromEnv !== "") {
      out[family] = fromEnv;
      continue;
    }
    if (usesOpenRouterForFamily(family, env) && OPENROUTER_ANTHROPIC_MODELS[family]) {
      out[family] = OPENROUTER_ANTHROPIC_MODELS[family];
    } else if (DEFAULT_ANTHROPIC_MODELS[family]) {
      out[family] = DEFAULT_ANTHROPIC_MODELS[family];
    } else if (DEFAULT_OPENROUTER_MODELS[family]) {
      out[family] = DEFAULT_OPENROUTER_MODELS[family];
    }
  }
  return out;
}

/** @deprecated use resolveCallerModels; kept for importers that read a snapshot. */
export const CALLER_MODELS = resolveCallerModels();

/** The model id for a family name, or null when the name is not one of ours. */
export function callerModel(name, env = process.env) {
  const key = String(name ?? "").toLowerCase();
  return resolveCallerModels(env)[key] ?? null;
}

/** The family a reader asked for, or the default when they asked for nothing valid. */
export function familyFor(name) {
  const asked = String(name ?? "").toLowerCase();
  return CALLER_FAMILIES.includes(asked) ? asked : DEFAULT_CALLER_FAMILY;
}

/** Label for a family id (selector + title). */
export function familyLabel(family) {
  const key = String(family ?? "").toLowerCase();
  return CALLER_LABELS[key] ?? `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`;
}

/** Fail fast at demo boot when credentials for the offered models are missing. */
export function assertCallerModelsConfigured(env = process.env) {
  const needsOpenRouter = CALLER_FAMILIES.some((f) => usesOpenRouterForFamily(f, env));
  const needsAnthropic = CALLER_FAMILIES.some(
    (f) => ANTHROPIC_FAMILIES.has(f) && !usesOpenRouterForFamily(f, env),
  );
  if (needsOpenRouter && !openRouterConfigured(env)) {
    throw new Error(
      "OPENROUTER_API_KEY is required for the caller models on offer (set it in the environment, e.g. from ~/.zshrc).",
    );
  }
  if (needsAnthropic && !anthropicDirectConfigured(env)) {
    throw new Error("ANTHROPIC_API_KEY is required for Haiku/Sonnet/Opus when not routing them through OpenRouter.");
  }
}

/**
 * Anthropic-compatible env for OpenRouter (shared by caller runs and the judge).
 */
function openRouterSdkEnv(env = process.env) {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return {};
  const base = (env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    HTTP_REFERER: env.OPENROUTER_HTTP_REFERER ?? "https://infino.ai",
    X_TITLE: env.OPENROUTER_X_TITLE ?? "Infino side-by-side demo",
  };
}

/** OpenRouter credentials for any Agent SDK subprocess when direct Anthropic is unset. */
export function sdkAuthEnv(env = process.env) {
  if (anthropicDirectConfigured(env)) return {};
  if (!openRouterConfigured(env)) return {};
  return openRouterSdkEnv(env);
}

/** OpenRouter-only setups cannot use the Claude Code OAuth preset; API-key mode needs a bare system prompt. */
export function stockExploreSystemPrompt(system, env = process.env) {
  if (env.DEMO_STOCK_CLAUDE_CODE_PRESET === "1") {
    return { type: "preset", preset: "claude_code", append: system };
  }
  if (env.DEMO_STOCK_CLAUDE_CODE_PRESET === "0") return system;
  if (Object.keys(sdkAuthEnv(env)).length > 0) return system;
  if (!anthropicDirectConfigured(env)) return system;
  return { type: "preset", preset: "claude_code", append: system };
}

/** Judge model id: OpenRouter slug when the demo routes Anthropic through OpenRouter. */
export function resolveJudgeModel(env = process.env) {
  const model = (env.JUDGE_MODEL ?? "claude-opus-5").trim();
  if (!model) return "claude-opus-5";
  if (openRouterConfigured(env) && !anthropicDirectConfigured(env)) {
    if (model === "claude-opus-5" || model.startsWith("claude-opus")) return OPENROUTER_ANTHROPIC_MODELS.opus;
    if (model.startsWith("anthropic/")) return model;
  }
  return model;
}

/**
 * Env overlay for the Claude Agent SDK subprocess when the family uses OpenRouter.
 * OpenRouter speaks an Anthropic-compatible messages API; the SDK reads
 * ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY.
 */
export function callerRunEnv(family, env = process.env) {
  const key = String(family ?? "").toLowerCase();
  if (!usesOpenRouterForFamily(key, env)) return {};
  const overlay = openRouterSdkEnv(env);
  if (!overlay.ANTHROPIC_API_KEY) {
    throw new Error(`OPENROUTER_API_KEY is required for caller model "${key}"`);
  }
  return overlay;
}
