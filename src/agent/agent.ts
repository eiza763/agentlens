import { SpanStatusCode, type Histogram, type Span } from "@opentelemetry/api";
import { provider } from "../config.js";
import { meter, tracer } from "../telemetry/otel.js";
import { AGENTLENS, GENAI, GENAI_OP, METRIC } from "../telemetry/genai.js";
import {
  assistantMessage,
  chat,
  toolResultMessage,
  type Message,
} from "../llm/client.js";
import { executeTool, TOOL_DEFS } from "./tools.js";
import type { Variant } from "./variants.js";
import type { Task } from "./tasks.js";

const MAX_STEPS = 8;
const MAX_TOKENS = 1024;

export interface RunResult {
  runId: string;
  traceId: string;
  taskId: string;
  variant: string;
  answer: string;
  toolSequence: string[];
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  escalated: boolean;
}

/** Metric instruments are created once per process, not per run. */
const instruments = (() => {
  let cached:
    | {
        tokenUsage: Histogram;
        runTokens: Histogram;
        runSteps: Histogram;
        runDuration: Histogram;
      }
    | undefined;
  return () => {
    if (!cached) {
      const m = meter();
      cached = {
        tokenUsage: m.createHistogram(METRIC.TOKEN_USAGE, {
          description: "Tokens used per LLM call",
          unit: "{token}",
        }),
        runTokens: m.createHistogram(METRIC.RUN_TOKENS, {
          description: "Total tokens used per agent run",
          unit: "{token}",
        }),
        runSteps: m.createHistogram(METRIC.RUN_STEPS, {
          description: "Reasoning steps (LLM calls) per agent run",
          unit: "{step}",
        }),
        runDuration: m.createHistogram(METRIC.RUN_DURATION, {
          description: "Wall-clock duration of an agent run",
          unit: "ms",
        }),
      };
    }
    return cached;
  };
})();

/**
 * Run the agent on one task.
 *
 * Span shape (this is what the evaluator later reads back out of SigNoz):
 *
 *   invoke_agent support-triage        <- root: question, answer, totals
 *     chat llama-3.3-70b-versatile     <- one per reasoning step, with token usage
 *     execute_tool lookup_order        <- one per tool call, with args + result
 *     chat llama-3.3-70b-versatile
 *     ...
 */
export async function runAgent(task: Task, variant: Variant, suite: string): Promise<RunResult> {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const providerName = provider().name;

  return tracer().startActiveSpan(`${GENAI_OP.INVOKE_AGENT} support-triage`, async (root: Span) => {
    root.setAttributes({
      [GENAI.OPERATION_NAME]: GENAI_OP.INVOKE_AGENT,
      [GENAI.AGENT_NAME]: "support-triage",
      [GENAI.PROVIDER_NAME]: providerName,
      [GENAI.REQUEST_MODEL]: variant.model,
      [AGENTLENS.RUN_ID]: runId,
      [AGENTLENS.TASK_ID]: task.id,
      [AGENTLENS.SUITE]: suite,
      [AGENTLENS.VARIANT]: variant.name,
      [AGENTLENS.QUESTION]: task.question,
    });

    const traceId = root.spanContext().traceId;
    const messages: Message[] = [{ role: "user", content: task.question }];
    const toolSequence: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let answer = "";
    let escalated = false;
    let steps = 0;

    try {
      for (let step = 1; step <= MAX_STEPS; step++) {
        steps = step;

        const result = await tracer().startActiveSpan(
          `${GENAI_OP.CHAT} ${variant.model}`,
          async (chatSpan) => {
            chatSpan.setAttributes({
              [GENAI.OPERATION_NAME]: GENAI_OP.CHAT,
              [GENAI.PROVIDER_NAME]: providerName,
              [GENAI.SYSTEM]: providerName,
              [GENAI.REQUEST_MODEL]: variant.model,
              [GENAI.REQUEST_MAX_TOKENS]: MAX_TOKENS,
              [AGENTLENS.RUN_ID]: runId,
              [AGENTLENS.TASK_ID]: task.id,
              [AGENTLENS.VARIANT]: variant.name,
              [AGENTLENS.STEP]: step,
            });

            try {
              const res = await chat({
                model: variant.model,
                system: variant.systemPrompt,
                messages,
                tools: TOOL_DEFS,
                maxTokens: MAX_TOKENS,
              });

              chatSpan.setAttributes({
                [GENAI.RESPONSE_MODEL]: res.model,
                [GENAI.RESPONSE_ID]: res.id,
                [GENAI.RESPONSE_FINISH_REASONS]: [res.finishReason],
                [GENAI.USAGE_INPUT_TOKENS]: res.inputTokens,
                [GENAI.USAGE_OUTPUT_TOKENS]: res.outputTokens,
              });

              const common = {
                [GENAI.PROVIDER_NAME]: providerName,
                [GENAI.REQUEST_MODEL]: variant.model,
                [GENAI.OPERATION_NAME]: GENAI_OP.CHAT,
                [AGENTLENS.VARIANT]: variant.name,
              };
              instruments().tokenUsage.record(res.inputTokens, {
                ...common,
                "gen_ai.token.type": "input",
              });
              instruments().tokenUsage.record(res.outputTokens, {
                ...common,
                "gen_ai.token.type": "output",
              });

              inputTokens += res.inputTokens;
              outputTokens += res.outputTokens;
              return res;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              chatSpan.recordException(err instanceof Error ? err : new Error(message));
              chatSpan.setStatus({ code: SpanStatusCode.ERROR, message });
              throw err;
            } finally {
              chatSpan.end();
            }
          },
        );

        if (result.text) answer = result.text;

        if (result.toolCalls.length === 0) {
          // No tool calls left to make: the model has produced its final answer.
          break;
        }

        messages.push(assistantMessage(result));

        for (const call of result.toolCalls) {
          toolSequence.push(call.name);
          if (call.name === "escalate_to_human") escalated = true;

          const outcome = executeTool(call.name, call.id, call.args, {
            runId,
            taskId: task.id,
            variant: variant.name,
            step,
          });

          messages.push(toolResultMessage(call.id, outcome.content));
        }
      }

      const latencyMs = Date.now() - startedAt;
      const totalTokens = inputTokens + outputTokens;

      root.setAttributes({
        [AGENTLENS.ANSWER]: answer,
        [AGENTLENS.TOOL_SEQUENCE]: toolSequence.join(","),
        [AGENTLENS.STEP_COUNT]: steps,
        [AGENTLENS.TOKENS_INPUT]: inputTokens,
        [AGENTLENS.TOKENS_OUTPUT]: outputTokens,
        [AGENTLENS.TOKENS_TOTAL]: totalTokens,
        [AGENTLENS.LATENCY_MS]: latencyMs,
        [AGENTLENS.ESCALATED]: escalated,
      });

      const dims = { [AGENTLENS.VARIANT]: variant.name, [AGENTLENS.TASK_ID]: task.id };
      instruments().runTokens.record(totalTokens, dims);
      instruments().runSteps.record(steps, dims);
      instruments().runDuration.record(latencyMs, dims);

      return {
        runId,
        traceId,
        taskId: task.id,
        variant: variant.name,
        answer,
        toolSequence,
        steps,
        inputTokens,
        outputTokens,
        totalTokens,
        latencyMs,
        escalated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      root.recordException(err instanceof Error ? err : new Error(message));
      root.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      root.end();
    }
  });
}
