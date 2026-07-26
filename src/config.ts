import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("<") || value === "sk-ant-...") {
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

export const config = {
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  /**
   * Optional on purpose. SigNoz Cloud authenticates OTLP ingestion with this
   * key; a self-hosted collector on localhost does not use one at all. Returning
   * "" lets the same code path serve both, and `otel.ts` omits the header when
   * it is empty.
   */
  get signozIngestionKey() {
    return process.env.SIGNOZ_INGESTION_KEY ?? "";
  },
  get otlpEndpoint() {
    return required("OTEL_EXPORTER_OTLP_ENDPOINT").replace(/\/$/, "");
  },
  get signozApiUrl() {
    return required("SIGNOZ_API_URL").replace(/\/$/, "");
  },
  /** Also optional: a self-hosted workspace with auth disabled needs no key. */
  get signozApiKey() {
    return process.env.SIGNOZ_API_KEY ?? "";
  },
  agentModel: optional("AGENT_MODEL", "claude-sonnet-5"),
  judgeModel: optional("JUDGE_MODEL", "claude-sonnet-5"),
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
