/**
 * OpenTelemetry GenAI semantic-convention attribute names.
 *
 * These are the conventions SigNoz (and the wider OTel ecosystem) expects for
 * LLM telemetry, so using them means SigNoz's own AI-agent views and any future
 * GenAI dashboards understand our spans without custom mapping.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * `agentlens.*` attributes are our own additions for things the spec does not
 * cover: which prompt variant produced the run, and the evaluation verdict.
 */

export const GENAI = {
  // Operation identity
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  SYSTEM: "gen_ai.system",

  // Request
  REQUEST_MODEL: "gen_ai.request.model",
  REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  REQUEST_TEMPERATURE: "gen_ai.request.temperature",

  // Response
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",

  // Usage
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",

  // Agent + tool
  AGENT_NAME: "gen_ai.agent.name",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_DESCRIPTION: "gen_ai.tool.description",

  // Conversation content (opt-in in the spec; we enable it because evaluation
  // reads the prompt and completion back out of the trace)
  INPUT_MESSAGES: "gen_ai.input.messages",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
} as const;

/** Span names follow the spec's `{operation} {target}` shape. */
export const GENAI_OP = {
  CHAT: "chat",
  INVOKE_AGENT: "invoke_agent",
  EXECUTE_TOOL: "execute_tool",
} as const;

export const AGENTLENS = {
  RUN_ID: "agentlens.run.id",
  TASK_ID: "agentlens.task.id",
  SUITE: "agentlens.suite",
  VARIANT: "agentlens.variant",
  STEP: "agentlens.step",
  STEP_COUNT: "agentlens.step.count",
  TOKENS_INPUT: "agentlens.tokens.input",
  TOKENS_OUTPUT: "agentlens.tokens.output",
  TOKENS_TOTAL: "agentlens.tokens.total",
  LATENCY_MS: "agentlens.latency.ms",
  TOOL_SEQUENCE: "agentlens.tool.sequence",
  TOOL_ERROR: "agentlens.tool.error",
  QUESTION: "agentlens.question",
  ANSWER: "agentlens.answer",
  ESCALATED: "agentlens.escalated",

  // Written by the evaluator onto its own spans
  EVAL_SCORE_OVERALL: "agentlens.eval.score.overall",
  EVAL_SCORE_COMPLETION: "agentlens.eval.score.task_completion",
  EVAL_SCORE_TOOLS: "agentlens.eval.score.tool_selection",
  EVAL_SCORE_GROUNDEDNESS: "agentlens.eval.score.groundedness",
  EVAL_SCORE_EFFICIENCY: "agentlens.eval.score.efficiency",
  EVAL_VERDICT: "agentlens.eval.verdict",
  EVAL_FAILURE_MODE: "agentlens.eval.failure_mode",
  EVAL_REASONING: "agentlens.eval.reasoning",
  EVAL_RUBRIC_PASS: "agentlens.eval.rubric.pass",
  EVAL_JUDGE_MODEL: "agentlens.eval.judge.model",
  EVAL_TARGET_TRACE_ID: "agentlens.eval.target.trace_id",
} as const;

/** Metric names emitted by the agent and the evaluator. */
export const METRIC = {
  // Emitted by the agent (semconv name, so it aggregates with other OTel apps)
  TOKEN_USAGE: "gen_ai.client.token.usage",
  OPERATION_DURATION: "gen_ai.client.operation.duration",
  // Emitted by the agent (AgentLens-specific)
  RUN_TOKENS: "agentlens.run.tokens",
  RUN_STEPS: "agentlens.run.steps",
  RUN_DURATION: "agentlens.run.duration",
  // Emitted by the evaluator
  EVAL_SCORE: "agentlens.eval.score",
  EVAL_RUNS: "agentlens.eval.runs",
  EVAL_FAILURES: "agentlens.eval.failures",
  /** Tokens attributed to a run, tagged with its verdict. Divide by verdict to
   *  get "tokens per successfully resolved task" vs "tokens burned on failures". */
  EVAL_TOKENS: "agentlens.eval.tokens",
} as const;
