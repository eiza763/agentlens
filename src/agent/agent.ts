import Anthropic from "@anthropic-ai/sdk";
import { SpanStatusCode, type Histogram, type Span } from "@opentelemetry/api";
import { config } from "../config.js";
import { meter, tracer } from "../telemetry/otel.js";
import { AGENTLENS, GENAI, GENAI_OP, METRIC } from "../telemetry/genai.js";
import { executeTool, TOOL_DEFS } from "./tools.js";
import type { Variant } from "./variants.js";
import type { Task } from "./tasks.js";

const MAX_STEPS = 8;
const MAX_TOKENS = 1024;

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

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
 *     chat claude-sonnet-5             <- one per reasoning step, with token usage
 *     execute_tool lookup_order        <- one per tool call, with args + result
 *     chat claude-sonnet-5
 *     ...
 */
export async function runAgent(task: Task, variant: Variant, suite: string): Promise<RunResult> {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  return tracer().startActiveSpan(`${GENAI_OP.INVOKE_AGENT} support-triage`, async (root: Span) => {
    root.setAttributes({
      [GENAI.OPERATION_NAME]: GENAI_OP.INVOKE_AGENT,
      [GENAI.AGENT_NAME]: "support-triage",
      [GENAI.PROVIDER_NAME]: "anthropic",
      [GENAI.REQUEST_MODEL]: variant.model,
      [AGENTLENS.RUN_ID]: runId,
      [AGENTLENS.TASK_ID]: task.id,
      [AGENTLENS.SUITE]: suite,
      [AGENTLENS.VARIANT]: variant.name,
      [AGENTLENS.QUESTION]: task.question,
    });

    const traceId = root.spanContext().traceId;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: task.question },
    ];
    const toolSequence: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let answer = "";
    let escalated = false;
    let steps = 0;

    try {
      for (let step = 1; step <= MAX_STEPS; step++) {
        steps = step;

        const response = await tracer().startActiveSpan(
          `${GENAI_OP.CHAT} ${variant.model}`,
          async (chatSpan) => {
            chatSpan.setAttributes({
              [GENAI.OPERATION_NAME]: GENAI_OP.CHAT,
              [GENAI.PROVIDER_NAME]: "anthropic",
              [GENAI.SYSTEM]: "anthropic",
              [GENAI.REQUEST_MODEL]: variant.model,
              [GENAI.REQUEST_MAX_TOKENS]: MAX_TOKENS,
              [AGENTLENS.RUN_ID]: runId,
              [AGENTLENS.TASK_ID]: task.id,
              [AGENTLENS.VARIANT]: variant.name,
              [AGENTLENS.STEP]: step,
            });

            try {
              const res = await anthropic().messages.create({
                model: variant.model,
                max_tokens: MAX_TOKENS,
                system: variant.systemPrompt,
                tools: TOOL_DEFS,
                messages,
              });

              chatSpan.setAttributes({
                [GENAI.RESPONSE_MODEL]: res.model,
                [GENAI.RESPONSE_ID]: res.id,
                [GENAI.RESPONSE_FINISH_REASONS]: [res.stop_reason ?? "unknown"],
                [GENAI.USAGE_INPUT_TOKENS]: res.usage.input_tokens,
                [GENAI.USAGE_OUTPUT_TOKENS]: res.usage.output_tokens,
              });

              const common = {
                [GENAI.PROVIDER_NAME]: "anthropic",
                [GENAI.REQUEST_MODEL]: variant.model,
                [GENAI.OPERATION_NAME]: GENAI_OP.CHAT,
                [AGENTLENS.VARIANT]: variant.name,
              };
              instruments().tokenUsage.record(res.usage.input_tokens, {
                ...common,
                "gen_ai.token.type": "input",
              });
              instruments().tokenUsage.record(res.usage.output_tokens, {
                ...common,
                "gen_ai.token.type": "output",
              });

              inputTokens += res.usage.input_tokens;
              outputTokens += res.usage.output_tokens;
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

        // Collect any text the model produced this step.
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) answer = text;

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        if (toolUses.length === 0) {
          // No tool calls left to make: the model has produced its final answer.
          break;
        }

        messages.push({ role: "assistant", content: response.content });

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
          toolSequence.push(toolUse.name);
          if (toolUse.name === "escalate_to_human") escalated = true;

          const outcome = executeTool(
            toolUse.name,
            toolUse.id,
            (toolUse.input ?? {}) as Record<string, unknown>,
            { runId, taskId: task.id, variant: variant.name, step },
          );

          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: outcome.content,
            is_error: outcome.isError,
          });
        }

        messages.push({ role: "user", content: results });
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
