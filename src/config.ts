import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("<") || value.endsWith("...")) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in ` +
        `(run \`npm run doctor\` to check your configuration).`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/**
 * LLM providers.
 *
 * All of these speak the OpenAI-compatible chat-completions protocol, so the
 * client code is identical across them — only the base URL and model names
 * differ. The `freeTier` flag documents which ones need no payment method,
 * because that is the deciding factor for most people running this.
 */
export interface Provider {
  name: string;
  baseUrl: string;
  /** Env var holding the key, for error messages. */
  keyVar: string;
  defaultAgentModel: string;
  defaultJudgeModel: string;
  /** A smaller/faster model on the same provider, for the `cheap` variant. */
  defaultCheapModel: string;
  freeTier: boolean;
  notes: string;
}

export const PROVIDERS: Record<string, Provider> = {
  groq: {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyVar: "GROQ_API_KEY",
    defaultAgentModel: "llama-3.3-70b-versatile",
    defaultJudgeModel: "llama-3.3-70b-versatile",
    defaultCheapModel: "llama-3.1-8b-instant",
    freeTier: true,
    notes: "Free, no card. Sign in at console.groq.com and create a key. Very fast.",
  },
  gemini: {
    name: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyVar: "GEMINI_API_KEY",
    defaultAgentModel: "gemini-2.0-flash",
    defaultJudgeModel: "gemini-2.0-flash",
    defaultCheapModel: "gemini-2.0-flash-lite",
    freeTier: true,
    notes: "Free tier, no card. Get a key at aistudio.google.com/apikey.",
  },
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    defaultAgentModel: "meta-llama/llama-3.3-70b-instruct",
    defaultJudgeModel: "meta-llama/llama-3.3-70b-instruct",
    defaultCheapModel: "meta-llama/llama-3.1-8b-instruct",
    freeTier: true,
    notes: "Has free models (look for ':free' suffixes). Tool support varies by model.",
  },
  anthropic: {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyVar: "ANTHROPIC_API_KEY",
    defaultAgentModel: "claude-sonnet-5",
    defaultJudgeModel: "claude-sonnet-5",
    defaultCheapModel: "claude-haiku-4-5-20251001",
    freeTier: false,
    notes: "Paid (small free grant on new accounts). Strongest tool use and judging.",
  },
  ollama: {
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    keyVar: "OLLAMA_API_KEY",
    defaultAgentModel: "llama3.1:8b",
    defaultJudgeModel: "llama3.1:8b",
    defaultCheapModel: "llama3.2:3b",
    freeTier: true,
    notes: "Fully local, no key needed. Needs a machine that can run the model.",
  },
};

export function provider(): Provider {
  const name = optional("LLM_PROVIDER", "groq").toLowerCase();
  const found = PROVIDERS[name];
  if (!found) {
    throw new Error(
      `Unknown LLM_PROVIDER "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return found;
}

export const config = {
  /**
   * The provider's API key. `LLM_API_KEY` wins if set, otherwise we look up the
   * provider's conventional variable so you can paste a GROQ_API_KEY and have it
   * just work.
   */
  get llmApiKey(): string {
    const generic = process.env.LLM_API_KEY;
    if (generic && generic.length > 0) return generic;
    const p = provider();
    const specific = process.env[p.keyVar];
    if (specific && specific.length > 0) return specific;
    // Ollama needs no real key but the SDK requires a non-empty string.
    if (p.name === "ollama") return "ollama";
    throw new Error(
      `No API key found for provider "${p.name}". Set ${p.keyVar} (or LLM_API_KEY) in .env.\n` +
        `  ${p.notes}`,
    );
  },

  /**
   * Optional on purpose. SigNoz Cloud authenticates OTLP ingestion with this
   * key; a self-hosted collector on localhost does not use one at all.
   */
  get signozIngestionKey(): string {
    return process.env.SIGNOZ_INGESTION_KEY ?? "";
  },
  get otlpEndpoint(): string {
    return required("OTEL_EXPORTER_OTLP_ENDPOINT").replace(/\/$/, "");
  },
  get signozApiUrl(): string {
    return required("SIGNOZ_API_URL").replace(/\/$/, "");
  },
  /** Required for reads even on a self-hosted instance. */
  get signozApiKey(): string {
    return process.env.SIGNOZ_API_KEY ?? "";
  },

  get agentModel(): string {
    return optional("AGENT_MODEL", provider().defaultAgentModel);
  },
  get judgeModel(): string {
    return optional("JUDGE_MODEL", provider().defaultJudgeModel);
  },
  get cheapModel(): string {
    return optional("CHEAP_MODEL", provider().defaultCheapModel);
  },

  scoreThreshold: Number(optional("AGENTLENS_SCORE_THRESHOLD", "0.75")),
  tokensPerSuccessThreshold: Number(optional("AGENTLENS_TOKENS_PER_SUCCESS_THRESHOLD", "12000")),
  debug: optional("AGENTLENS_DEBUG", "0") === "1",
};

/** Service names, kept in one place because dashboards and queries filter on them. */
export const SERVICE = {
  agent: "agentlens-agent",
  evaluator: "agentlens-evaluator",
} as const;

/** Span names the evaluator relies on to find agent runs. */
export const SPAN = {
  agentRun: "invoke_agent support-triage",
  evaluation: "evaluate_run support-triage",
} as const;
