/**
 * Evaluation pass: read runs out of SigNoz, grade them, write scores back.
 */
import { TASKS, type Task } from "../agent/tasks.js";
import { findAgentRuns, hydrateRun, type ReconstructedRun } from "./reconstruct.js";
import { applyRubric } from "./rubric.js";
import { judgeRun, type Judgement } from "./judge.js";
import { emitEvaluation } from "./emit.js";

const TASK_BY_ID = new Map<string, Task>(TASKS.map((t) => [t.id, t]));

export interface EvaluatedRun {
  run: ReconstructedRun;
  judgement: Judgement;
  rubricPass: boolean;
  failedChecks: string[];
}

export interface EvaluatePassOptions {
  lookbackMinutes: number;
  variant?: string;
  limit?: number;
  /** Skip runs already evaluated in this process (keyed by trace ID). */
  seen?: Set<string>;
  onProgress?: (message: string) => void;
}

export async function evaluatePass(opts: EvaluatePassOptions): Promise<EvaluatedRun[]> {
  const endMs = Date.now();
  const startMs = endMs - opts.lookbackMinutes * 60_000;
  const log = opts.onProgress ?? (() => {});

  const rootRows = await findAgentRuns({
    startMs,
    endMs,
    variant: opts.variant,
    limit: opts.limit,
  });

  if (rootRows.length === 0) {
    log(
      `No agent runs found in SigNoz for the last ${opts.lookbackMinutes} minute(s).\n` +
        `  If you just ran the agent, wait ~15s for ingestion and retry.\n` +
        `  Set AGENTLENS_DEBUG=1 to see the raw query response.`,
    );
    return [];
  }

  log(`Found ${rootRows.length} agent run(s) in SigNoz.`);

  const results: EvaluatedRun[] = [];

  for (const rootRow of rootRows) {
    const run = await hydrateRun(rootRow, { startMs, endMs });
    if (!run) continue;
    if (opts.seen?.has(run.traceId)) continue;
    opts.seen?.add(run.traceId);

    const task = TASK_BY_ID.get(run.taskId);
    const rubric = applyRubric(run, task);

    let judgement: Judgement;
    try {
      judgement = await judgeRun(run, task, rubric);
    } catch (err) {
      log(`  ! judge failed for ${run.taskId} (${run.traceId.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    emitEvaluation(run, judgement, rubric);

    const failedChecks = rubric.checks.filter((c) => !c.pass).map((c) => c.name);
    results.push({ run, judgement, rubricPass: rubric.pass, failedChecks });

    const mark = judgement.verdict === "pass" ? "PASS" : "FAIL";
    log(
      `  ${mark}  ${run.taskId.padEnd(26)} ${run.variant.padEnd(10)} ` +
        `overall=${judgement.overall.toFixed(2)} ground=${judgement.scores.groundedness.toFixed(2)} ` +
        `tokens=${run.totalTokens} ${judgement.failure_mode !== "none" ? `[${judgement.failure_mode}]` : ""}`,
    );
  }

  return results;
}

export function summarise(results: EvaluatedRun[]): {
  count: number;
  passed: number;
  failed: number;
  meanOverall: number;
  meanGroundedness: number;
  tokensPerSuccess: number;
  wastedTokens: number;
  byVariant: Record<string, { count: number; meanOverall: number; passed: number }>;
  failureModes: Record<string, number>;
} {
  const count = results.length;
  const passed = results.filter((r) => r.judgement.verdict === "pass");
  const failed = results.filter((r) => r.judgement.verdict === "fail");

  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

  const byVariant: Record<string, { count: number; meanOverall: number; passed: number }> = {};
  for (const result of results) {
    const key = result.run.variant;
    byVariant[key] ??= { count: 0, meanOverall: 0, passed: 0 };
    const bucket = byVariant[key];
    if (bucket) {
      bucket.count += 1;
      bucket.meanOverall += result.judgement.overall;
      if (result.judgement.verdict === "pass") bucket.passed += 1;
    }
  }
  for (const bucket of Object.values(byVariant)) {
    bucket.meanOverall = bucket.count ? Number((bucket.meanOverall / bucket.count).toFixed(4)) : 0;
  }

  const failureModes: Record<string, number> = {};
  for (const result of results) {
    const mode = result.judgement.failure_mode;
    if (mode === "none") continue;
    failureModes[mode] = (failureModes[mode] ?? 0) + 1;
  }

  return {
    count,
    passed: passed.length,
    failed: failed.length,
    meanOverall: Number(mean(results.map((r) => r.judgement.overall)).toFixed(4)),
    meanGroundedness: Number(mean(results.map((r) => r.judgement.scores.groundedness)).toFixed(4)),
    // Tokens spent divided by *successful* runs: the honest efficiency number,
    // because tokens burned on a wrong answer bought nothing.
    tokensPerSuccess:
      passed.length === 0
        ? 0
        : Math.round(results.reduce((s, r) => s + r.run.totalTokens, 0) / passed.length),
    wastedTokens: failed.reduce((s, r) => s + r.run.totalTokens, 0),
    byVariant,
    failureModes,
  };
}
