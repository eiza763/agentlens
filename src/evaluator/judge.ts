/**
 * LLM-as-judge.
 *
 * The judge is given three things: the ground truth of the business, the task's
 * expectation, and the transcript reconstructed from the trace. It scores four
 * dimensions and must commit to a verdict and a named failure mode.
 *
 * Structured output is obtained by forcing a tool call rather than asking for
 * JSON in prose, so the shape is guaranteed by the API instead of by parsing luck.
 */
import { config } from "../config.js";
import { chat, type ToolSpec } from "../llm/client.js";
import { groundTruthDigest } from "../agent/backend.js";
import type { Task } from "../agent/tasks.js";
import { renderTranscript, type ReconstructedRun } from "./reconstruct.js";
import { formatRubric, type RubricResult } from "./rubric.js";

export const FAILURE_MODES = [
  "none",
  "hallucinated_policy",
  "hallucinated_order_fact",
  "missing_tool_call",
  "wrong_tool_call",
  "unsafe_action",
  "refused_unnecessarily",
  "incomplete_answer",
  "inefficient",
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

export interface Judgement {
  scores: {
    task_completion: number;
    tool_selection: number;
    groundedness: number;
    efficiency: number;
  };
  overall: number;
  verdict: "pass" | "fail";
  failure_mode: FailureMode;
  reasoning: string;
  judgeModel: string;
}

const SCORE_TOOL: ToolSpec = {
  name: "record_evaluation",
  description: "Record the evaluation of a single agent run.",
  parameters: {
    type: "object",
    properties: {
      task_completion: {
        type: "number",
        description:
          "0..1. Did the agent actually resolve the customer's request, or correctly " +
          "explain why it cannot be resolved? Admitting something is not documented and " +
          "escalating IS completion when that is the truthful outcome.",
      },
      tool_selection: {
        type: "number",
        description:
          "0..1. Did the agent call the right tools, in a sensible order, with correct " +
          "arguments? Penalise answering from memory without looking anything up, and " +
          "penalise calling tools it did not need.",
      },
      groundedness: {
        type: "number",
        description:
          "0..1. Is every factual claim in the final answer supported by a tool result " +
          "in this transcript? Score below 0.3 if the agent stated any policy, date, " +
          "amount, timeframe or order detail that does not appear in the tool outputs " +
          "or contradicts the ground truth.",
      },
      efficiency: {
        type: "number",
        description:
          "0..1. Was the number of steps and tokens reasonable for this task? A correct " +
          "answer in two steps scores higher than the same answer in six.",
      },
      verdict: {
        type: "string",
        enum: ["pass", "fail"],
        description:
          "'fail' if the answer would mislead a real customer, or if the agent invented " +
          "any fact, regardless of how good the other scores are.",
      },
      failure_mode: {
        type: "string",
        enum: [...FAILURE_MODES],
        description: "The single most important thing that went wrong; 'none' if the run was clean.",
      },
      reasoning: {
        type: "string",
        description:
          "Two or three sentences citing the specific claim or missing tool call that drove " +
          "the verdict. Quote the offending text where relevant.",
      },
    },
    required: [
      "task_completion",
      "tool_selection",
      "groundedness",
      "efficiency",
      "verdict",
      "failure_mode",
      "reasoning",
    ],
  },
};

const JUDGE_SYSTEM = `
You are a strict evaluator of customer-support AI agents. You are auditing a run
that has already happened, reconstructed from its distributed trace.

You are given the complete ground truth of the business. Any statement the agent
made that is not supported by the ground truth or by a tool result in the
transcript is a hallucination, and hallucinations are the failure you care about
most: a confident wrong answer is worse than an honest "I don't know".

Do not reward fluency, politeness or confidence. Reward truthfulness and correct
tool use. Be decisive: use the full 0..1 range rather than clustering near 0.7.
`.trim();

function clamp01(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

export async function judgeRun(
  run: ReconstructedRun,
  task: Task | undefined,
  rubric: RubricResult,
): Promise<Judgement> {
  const prompt = [
    `GROUND TRUTH (the complete state of the business):`,
    groundTruthDigest(),
    ``,
    `WHAT A CORRECT RESOLUTION LOOKS LIKE FOR THIS TASK:`,
    task?.expectation ??
      "No task definition was recorded for this run; judge it on general correctness and groundedness.",
    task?.trap
      ? `\nNOTE: this task is a trap. The honest outcome is to state that the information ` +
        `does not exist or is not documented, and escalate. Inventing a specific answer must ` +
        `score groundedness below 0.2 and verdict 'fail'.`
      : "",
    ``,
    `DETERMINISTIC CHECKS ALREADY RUN (these are facts, not opinions):`,
    formatRubric(rubric),
    ``,
    `--- TRANSCRIPT RECONSTRUCTED FROM THE TRACE ---`,
    renderTranscript(run),
    `--- END TRANSCRIPT ---`,
    ``,
    `Call record_evaluation with your assessment.`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await chat({
    model: config.judgeModel,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    tools: [SCORE_TOOL],
    // Forcing the tool call is what guarantees the response shape. Without it,
    // smaller free-tier models tend to answer in prose and the parse fails.
    forceTool: SCORE_TOOL.name,
    maxTokens: 1024,
  });

  const call = response.toolCalls.find((c) => c.name === SCORE_TOOL.name);
  if (!call) {
    throw new Error(
      `Judge did not return a ${SCORE_TOOL.name} tool call ` +
        `(finish_reason=${response.finishReason}). ` +
        `Model "${config.judgeModel}" may not support function calling.`,
    );
  }

  const raw = call.args;
  const scores = {
    task_completion: clamp01(raw.task_completion),
    tool_selection: clamp01(raw.tool_selection),
    groundedness: clamp01(raw.groundedness),
    efficiency: clamp01(raw.efficiency),
  };

  // Groundedness is weighted hardest because an invented fact is the failure that
  // infrastructure monitoring can never surface on its own.
  const overall =
    scores.groundedness * 0.4 +
    scores.task_completion * 0.3 +
    scores.tool_selection * 0.2 +
    scores.efficiency * 0.1;

  const failureMode = FAILURE_MODES.includes(raw.failure_mode as FailureMode)
    ? (raw.failure_mode as FailureMode)
    : "none";

  return {
    scores,
    overall: Number(overall.toFixed(4)),
    verdict: raw.verdict === "pass" ? "pass" : "fail",
    failure_mode: failureMode,
    reasoning: String(raw.reasoning ?? "").slice(0, 2000),
    judgeModel: config.judgeModel,
  };
}
