/**
 * Write evaluations back into SigNoz.
 *
 * Two things are emitted per judged run:
 *
 * 1. An evaluation SPAN, carrying an OpenTelemetry span *link* to the agent
 *    trace it graded. In the SigNoz UI that link is what lets you sit on a
 *    failing score and jump straight to the exact conversation that produced it.
 *    Score and answer live in the same trace graph, not in two disconnected tools.
 *
 * 2. Evaluation METRICS, which are what dashboards, alerts and the regression
 *    gate actually read. Metrics are cheap to aggregate over thousands of runs;
 *    spans are for looking at one run in detail.
 */
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  type Counter,
  type Histogram,
  type Link,
} from "@opentelemetry/api";
import { meter, tracer } from "../telemetry/otel.js";
import { AGENTLENS, METRIC } from "../telemetry/genai.js";
import { SPAN } from "../config.js";
import type { ReconstructedRun } from "./reconstruct.js";
import type { Judgement } from "./judge.js";
import type { RubricResult } from "./rubric.js";

interface Instruments {
  score: Histogram;
  runs: Counter;
  failures: Counter;
  tokens: Histogram;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
  if (!instruments) {
    const m = meter();
    instruments = {
      score: m.createHistogram(METRIC.EVAL_SCORE, {
        description: "Evaluation score per dimension, 0..1",
        unit: "1",
      }),
      runs: m.createCounter(METRIC.EVAL_RUNS, {
        description: "Evaluated agent runs, tagged with verdict",
        unit: "{run}",
      }),
      failures: m.createCounter(METRIC.EVAL_FAILURES, {
        description: "Failed agent runs, tagged with failure mode",
        unit: "{run}",
      }),
      tokens: m.createHistogram(METRIC.EVAL_TOKENS, {
        description: "Tokens consumed by a run, tagged with its verdict",
        unit: "{token}",
      }),
    };
  }
  return instruments;
}

/**
 * A span link needs a SpanContext, but the query API hands us plain hex strings,
 * so the context is rebuilt by hand from the agent run's own trace and span IDs.
 *
 * Both IDs must be valid lowercase hex of exactly the right length (32 and 16);
 * anything else is dropped silently by the collector, so we validate and skip
 * the link rather than emit a broken one. `EVAL_TARGET_TRACE_ID` is always set
 * as an attribute regardless, so the run is still findable by search.
 */
function linkToRun(run: ReconstructedRun): Link[] {
  const traceId = run.traceId.replace(/[^0-9a-f]/gi, "").toLowerCase();
  const spanId = run.spanId.replace(/[^0-9a-f]/gi, "").toLowerCase();

  const validTrace = traceId.length === 32 && /[1-9a-f]/.test(traceId);
  const validSpan = spanId.length === 16 && /[1-9a-f]/.test(spanId);
  if (!validTrace || !validSpan) return [];

  return [
    {
      context: { traceId, spanId, traceFlags: TraceFlags.SAMPLED },
      attributes: { "agentlens.link.kind": "evaluated_run" },
    },
  ];
}

export function emitEvaluation(
  run: ReconstructedRun,
  judgement: Judgement,
  rubric: RubricResult,
): void {
  const span = tracer().startSpan(
    SPAN.evaluation,
    { links: linkToRun(run) },
    ROOT_CONTEXT, // evaluations are their own traces, not children of anything
  );

  span.setAttributes({
    [AGENTLENS.RUN_ID]: run.runId,
    [AGENTLENS.TASK_ID]: run.taskId,
    [AGENTLENS.SUITE]: run.suite,
    [AGENTLENS.VARIANT]: run.variant,
    [AGENTLENS.EVAL_TARGET_TRACE_ID]: run.traceId,
    [AGENTLENS.EVAL_SCORE_OVERALL]: judgement.overall,
    [AGENTLENS.EVAL_SCORE_COMPLETION]: judgement.scores.task_completion,
    [AGENTLENS.EVAL_SCORE_TOOLS]: judgement.scores.tool_selection,
    [AGENTLENS.EVAL_SCORE_GROUNDEDNESS]: judgement.scores.groundedness,
    [AGENTLENS.EVAL_SCORE_EFFICIENCY]: judgement.scores.efficiency,
    [AGENTLENS.EVAL_VERDICT]: judgement.verdict,
    [AGENTLENS.EVAL_FAILURE_MODE]: judgement.failure_mode,
    [AGENTLENS.EVAL_REASONING]: judgement.reasoning,
    [AGENTLENS.EVAL_RUBRIC_PASS]: rubric.pass,
    [AGENTLENS.EVAL_JUDGE_MODEL]: judgement.judgeModel,
    [AGENTLENS.TOKENS_TOTAL]: run.totalTokens,
    [AGENTLENS.STEP_COUNT]: run.steps,
    [AGENTLENS.LATENCY_MS]: run.latencyMs,
    [AGENTLENS.ANSWER]: run.answer,
    [AGENTLENS.QUESTION]: run.question,
    "agentlens.eval.rubric.failed_checks": rubric.checks
      .filter((c) => !c.pass)
      .map((c) => c.name)
      .join(","),
  });

  // A failed evaluation is marked as a span error so it shows up in SigNoz's
  // error-rate views without any extra configuration.
  if (judgement.verdict === "fail") {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `${judgement.failure_mode}: ${judgement.reasoning.slice(0, 160)}`,
    });
  }

  span.end();

  const dims = {
    [AGENTLENS.VARIANT]: run.variant,
    [AGENTLENS.TASK_ID]: run.taskId,
    [AGENTLENS.SUITE]: run.suite,
  };
  const inst = getInstruments();

  inst.score.record(judgement.overall, { ...dims, "agentlens.eval.dimension": "overall" });
  inst.score.record(judgement.scores.task_completion, { ...dims, "agentlens.eval.dimension": "task_completion" });
  inst.score.record(judgement.scores.tool_selection, { ...dims, "agentlens.eval.dimension": "tool_selection" });
  inst.score.record(judgement.scores.groundedness, { ...dims, "agentlens.eval.dimension": "groundedness" });
  inst.score.record(judgement.scores.efficiency, { ...dims, "agentlens.eval.dimension": "efficiency" });

  inst.runs.add(1, { ...dims, [AGENTLENS.EVAL_VERDICT]: judgement.verdict });
  inst.tokens.record(run.totalTokens, { ...dims, [AGENTLENS.EVAL_VERDICT]: judgement.verdict });

  if (judgement.verdict === "fail") {
    inst.failures.add(1, { ...dims, [AGENTLENS.EVAL_FAILURE_MODE]: judgement.failure_mode });
  }
}
