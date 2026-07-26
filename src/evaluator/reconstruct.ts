/**
 * Rebuild agent runs from telemetry.
 *
 * This module is the heart of the project's claim: the evaluator has no access
 * to the agent's process, memory, return values or logs. It knows only what
 * SigNoz stored. Everything needed to grade a run — the question, the answer,
 * which tools were called with which arguments and what they returned — is read
 * back out of spans.
 *
 * The practical consequence is that AgentLens can grade a run that happened on
 * another machine, in another language, yesterday.
 */
import { AGENTLENS, GENAI } from "../telemetry/genai.js";
import { SERVICE, SPAN } from "../config.js";
import { attr, numAttr, queryRawSpans, type Row } from "../signoz/client.js";

export interface ToolCall {
  name: string;
  input: string;
  output: string;
  isError: boolean;
  step: number;
}

export interface ReconstructedRun {
  traceId: string;
  /** The root span's own ID, needed to build a valid span link back to this run. */
  spanId: string;
  runId: string;
  taskId: string;
  variant: string;
  suite: string;
  question: string;
  answer: string;
  toolCalls: ToolCall[];
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  escalated: boolean;
}

const ROOT_FIELDS = [
  { name: "trace_id" },
  { name: "span_id" },
  { name: "name" },
  { name: "service.name", fieldContext: "resource" as const },
  { name: AGENTLENS.RUN_ID },
  { name: AGENTLENS.TASK_ID },
  { name: AGENTLENS.SUITE },
  { name: AGENTLENS.VARIANT },
  { name: AGENTLENS.QUESTION },
  { name: AGENTLENS.ANSWER },
  { name: AGENTLENS.TOOL_SEQUENCE },
  { name: AGENTLENS.STEP_COUNT },
  { name: AGENTLENS.TOKENS_INPUT },
  { name: AGENTLENS.TOKENS_OUTPUT },
  { name: AGENTLENS.TOKENS_TOTAL },
  { name: AGENTLENS.LATENCY_MS },
  { name: AGENTLENS.ESCALATED },
];

const CHILD_FIELDS = [
  { name: "trace_id" },
  { name: "span_id" },
  { name: "name" },
  { name: GENAI.OPERATION_NAME },
  { name: GENAI.TOOL_NAME },
  { name: GENAI.USAGE_INPUT_TOKENS },
  { name: GENAI.USAGE_OUTPUT_TOKENS },
  { name: AGENTLENS.STEP },
  { name: AGENTLENS.TOOL_ERROR },
  { name: "agentlens.tool.input" },
  { name: "agentlens.tool.output" },
];

/** Find agent runs recorded in the given window. */
export async function findAgentRuns(opts: {
  startMs: number;
  endMs: number;
  variant?: string;
  limit?: number;
}): Promise<Row[]> {
  const clauses = [
    `service.name = '${SERVICE.agent}'`,
    `name = '${SPAN.agentRun}'`,
  ];
  if (opts.variant) clauses.push(`${AGENTLENS.VARIANT} = '${opts.variant}'`);

  return queryRawSpans({
    expression: clauses.join(" AND "),
    selectFields: ROOT_FIELDS,
    startMs: opts.startMs,
    endMs: opts.endMs,
    limit: opts.limit ?? 100,
  });
}

/** Fetch the child spans of one run and turn them into a tool-call timeline. */
export async function hydrateRun(
  rootRow: Row,
  window: { startMs: number; endMs: number },
): Promise<ReconstructedRun | null> {
  const traceId = attr(rootRow, "trace_id", "traceId", "traceID");
  if (!traceId) return null;

  const childRows = await queryRawSpans({
    // Widen slightly: children share the trace but the window is caller-supplied.
    expression: `trace_id = '${traceId}'`,
    selectFields: CHILD_FIELDS,
    startMs: window.startMs,
    endMs: window.endMs,
    limit: 200,
    orderDesc: false,
  });

  const toolCalls: ToolCall[] = childRows
    .filter((row) => attr(row, GENAI.TOOL_NAME) !== undefined)
    .map((row) => ({
      name: attr(row, GENAI.TOOL_NAME) ?? "unknown",
      input: attr(row, "agentlens.tool.input") ?? "{}",
      output: attr(row, "agentlens.tool.output") ?? "",
      isError: (attr(row, AGENTLENS.TOOL_ERROR) ?? "false").toLowerCase() === "true",
      step: numAttr(row, AGENTLENS.STEP) ?? 0,
    }))
    .sort((a, b) => a.step - b.step);

  // Prefer the root span's rollups; fall back to summing chat spans when a
  // partial trace is all we have.
  const chatRows = childRows.filter(
    (row) => attr(row, GENAI.OPERATION_NAME) === "chat",
  );
  const summedIn = chatRows.reduce((s, r) => s + (numAttr(r, GENAI.USAGE_INPUT_TOKENS) ?? 0), 0);
  const summedOut = chatRows.reduce((s, r) => s + (numAttr(r, GENAI.USAGE_OUTPUT_TOKENS) ?? 0), 0);

  const inputTokens = numAttr(rootRow, AGENTLENS.TOKENS_INPUT) ?? summedIn;
  const outputTokens = numAttr(rootRow, AGENTLENS.TOKENS_OUTPUT) ?? summedOut;

  // A run with no recorded answer cannot be graded; skip rather than guess.
  const answer = attr(rootRow, AGENTLENS.ANSWER);
  const question = attr(rootRow, AGENTLENS.QUESTION);
  if (!question) return null;

  const sequenceFromRoot = attr(rootRow, AGENTLENS.TOOL_SEQUENCE);

  return {
    traceId,
    spanId: attr(rootRow, "span_id", "spanId", "spanID") ?? "",
    runId: attr(rootRow, AGENTLENS.RUN_ID) ?? traceId,
    taskId: attr(rootRow, AGENTLENS.TASK_ID) ?? "unknown",
    variant: attr(rootRow, AGENTLENS.VARIANT) ?? "unknown",
    suite: attr(rootRow, AGENTLENS.SUITE) ?? "default",
    question,
    answer: answer ?? "",
    toolCalls:
      toolCalls.length > 0
        ? toolCalls
        : // Fall back to the root's flattened sequence if child spans are missing.
          (sequenceFromRoot ?? "")
            .split(",")
            .filter(Boolean)
            .map((name, i) => ({ name, input: "{}", output: "", isError: false, step: i + 1 })),
    steps: numAttr(rootRow, AGENTLENS.STEP_COUNT) ?? chatRows.length,
    inputTokens,
    outputTokens,
    totalTokens: numAttr(rootRow, AGENTLENS.TOKENS_TOTAL) ?? inputTokens + outputTokens,
    latencyMs: numAttr(rootRow, AGENTLENS.LATENCY_MS) ?? 0,
    escalated: (attr(rootRow, AGENTLENS.ESCALATED) ?? "false").toLowerCase() === "true",
  };
}

/** Render a run as the transcript the judge reads. */
export function renderTranscript(run: ReconstructedRun): string {
  const tools = run.toolCalls.length
    ? run.toolCalls
        .map(
          (t, i) =>
            `${i + 1}. ${t.name}(${t.input})\n   -> ${t.isError ? "[TOOL ERROR] " : ""}${t.output || "(no output recorded)"}`,
        )
        .join("\n")
    : "(the agent called no tools)";

  return [
    `CUSTOMER QUESTION:\n${run.question}`,
    ``,
    `TOOL CALLS THE AGENT MADE (in order):\n${tools}`,
    ``,
    `FINAL ANSWER THE AGENT GAVE THE CUSTOMER:\n${run.answer || "(the agent produced no answer)"}`,
    ``,
    `RUN STATISTICS: ${run.steps} reasoning steps, ${run.totalTokens} total tokens, ${run.latencyMs}ms.`,
  ].join("\n");
}
