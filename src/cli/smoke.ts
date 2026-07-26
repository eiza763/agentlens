/**
 * Local smoke test: run the agent and judge it in-process, with NO SigNoz.
 *
 *   npm run smoke
 *   npm run smoke -- --variant regressed
 *   npm run smoke -- --tasks T05,T06,T07 --compare
 *
 * Purpose: verify the LLM provider, tool calling, the rubric and the judge all
 * work before you involve SigNoz. It needs only an LLM API key. If this passes
 * and the full demo fails, the problem is SigNoz configuration, not the project.
 *
 * IMPORTANT — this is a diagnostic, not the product. It bypasses the whole point
 * of AgentLens by judging in-process instead of reading traces back from SigNoz.
 * `npm run demo` is the real pipeline. Use this only to isolate faults.
 */
import { getTasks, TASKS, type Task } from "../agent/tasks.js";
import { getVariant } from "../agent/variants.js";
import { runAgent, type RunResult } from "../agent/agent.js";
import { applyRubric } from "../evaluator/rubric.js";
import { judgeRun, type Judgement } from "../evaluator/judge.js";
import type { ReconstructedRun } from "../evaluator/reconstruct.js";
import { config, provider } from "../config.js";
import { parseArgs } from "./args.js";

/**
 * Adapt an in-process run to the shape the evaluator expects.
 *
 * In the real pipeline this object is rebuilt from spans queried out of SigNoz.
 * Here we hand it over directly, which is exactly the shortcut the production
 * path refuses to take.
 */
function asReconstructed(result: RunResult, suite: string): ReconstructedRun {
  return {
    traceId: result.traceId,
    spanId: "",
    runId: result.runId,
    taskId: result.taskId,
    variant: result.variant,
    suite,
    question: TASKS.find((t) => t.id === result.taskId)?.question ?? "",
    answer: result.answer,
    toolCalls: result.toolCalls,
    steps: result.steps,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalTokens: result.totalTokens,
    latencyMs: result.latencyMs,
    escalated: result.escalated,
  };
}

interface Scored {
  task: Task;
  result: RunResult;
  judgement: Judgement;
  rubricPass: boolean;
  failedChecks: string[];
}

async function runVariant(
  variantName: string,
  tasks: Task[],
  suite: string,
  repeat: number,
): Promise<Scored[]> {
  const variant = getVariant(variantName);
  console.log(`\n--- variant: ${variant.name} (${variant.model}) ---`);
  console.log(`    ${variant.description}`);
  if (repeat > 1) console.log(`    ${repeat} repetitions per task`);
  console.log("");

  const scored: Scored[] = [];

  // LLMs are stochastic, so a single run per task produces noise comparable to
  // the effect being measured. Repetitions are how the regression becomes a
  // reliable signal rather than a coin flip.
  const queue = tasks.flatMap((task) => Array.from({ length: repeat }, () => task));

  for (const task of queue) {
    try {
      const result = await runAgent(task, variant, suite);
      const run = asReconstructed(result, suite);
      const rubric = applyRubric(run, task);
      const judgement = await judgeRun(run, task, rubric);

      const mark = judgement.verdict === "pass" ? "PASS" : "FAIL";
      console.log(
        `  ${mark}  ${task.id.padEnd(26)} overall=${judgement.overall.toFixed(2)} ` +
          `ground=${judgement.scores.groundedness.toFixed(2)} tools=${judgement.scores.tool_selection.toFixed(2)} ` +
          `steps=${result.steps} tokens=${result.totalTokens}`,
      );
      console.log(`        called: [${result.toolSequence.join(" ") || "nothing"}]`);
      console.log(`        said:   ${result.answer.replace(/\s+/g, " ").slice(0, 150)}`);
      if (judgement.verdict === "fail") {
        console.log(`        why:    ${judgement.failure_mode} — ${judgement.reasoning.replace(/\s+/g, " ").slice(0, 220)}`);
      }

      scored.push({
        task,
        result,
        judgement,
        rubricPass: rubric.pass,
        failedChecks: rubric.checks.filter((c) => !c.pass).map((c) => c.name),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR ${task.id}: ${message}`);
      if (/429|rate/i.test(message)) {
        console.error(`        (free-tier rate limit — wait a minute and rerun)`);
      }
    }
  }

  return scored;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function summarise(label: string, scored: Scored[]): void {
  if (scored.length === 0) {
    console.log(`  ${label.padEnd(12)} no runs completed`);
    return;
  }
  const passed = scored.filter((s) => s.judgement.verdict === "pass").length;
  console.log(
    `  ${label.padEnd(12)} n=${String(scored.length).padEnd(3)} ` +
      `passed=${passed}/${scored.length}  ` +
      `overall=${mean(scored.map((s) => s.judgement.overall)).toFixed(3)}  ` +
      `groundedness=${mean(scored.map((s) => s.judgement.scores.groundedness)).toFixed(3)}  ` +
      `tokens=${Math.round(mean(scored.map((s) => s.result.totalTokens)))}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = getTasks(args.list("tasks"));
  const suite = args.string("suite") ?? "smoke";
  const compare = args.bool("compare");
  const variantName = args.string("variant") ?? "baseline";
  const repeat = Math.max(1, args.number("repeat") ?? 1);

  console.log(`\nAgentLens — local smoke test (no SigNoz involved)`);
  console.log(`  provider : ${provider().name}`);
  console.log(`  agent    : ${config.agentModel}`);
  console.log(`  judge    : ${config.judgeModel}`);
  console.log(`  tasks    : ${tasks.length}${repeat > 1 ? ` x ${repeat} reps` : ""}`);

  if (compare) {
    const baseline = await runVariant("baseline", tasks, suite, repeat);
    const regressed = await runVariant("regressed", tasks, suite, repeat);

    console.log(`\n==== comparison ====`);
    summarise("baseline", baseline);
    summarise("regressed", regressed);

    const drop =
      mean(baseline.map((s) => s.judgement.scores.groundedness)) -
      mean(regressed.map((s) => s.judgement.scores.groundedness));
    console.log(
      `\n  groundedness delta: ${drop >= 0 ? "-" : "+"}${Math.abs(drop).toFixed(3)} ` +
        `(baseline -> regressed)`,
    );
    if (drop <= 0.05) {
      console.log(
        `  NOTE: the regression did not clearly show up. Smaller models sometimes\n` +
          `  ignore the prompt change. Try --tasks T05,T06,T07 (the trap tasks), or a\n` +
          `  stronger model via AGENT_MODEL.`,
      );
    }
    console.log("");
    return;
  }

  const scored = await runVariant(variantName, tasks, suite, repeat);
  console.log(`\n==== summary ====`);
  summarise(variantName, scored);
  console.log("");
}

main().catch((err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
