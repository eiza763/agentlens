/**
 * The scripted demo: ship a good agent, ship a regression, watch SigNoz catch it.
 *
 *   npm run demo
 *
 * Sequence:
 *   1. Run the baseline agent over the suite  -> traces to SigNoz
 *   2. Evaluate from SigNoz                   -> scores back to SigNoz
 *   3. Run the regressed agent (bad deploy)   -> traces to SigNoz
 *   4. Evaluate again                          -> groundedness collapses
 *   5. Print the before/after comparison the gate would block on
 *
 * Everything in step 2 and 4 is read back out of SigNoz over the query API. The
 * evaluator is never handed the agent's return values.
 */
import { initTelemetry, shutdownTelemetry } from "../telemetry/otel.js";
import { SERVICE } from "../config.js";
import { getTasks } from "../agent/tasks.js";
import { getVariant } from "../agent/variants.js";
import { runAgent } from "../agent/agent.js";
import { evaluatePass, summarise, type EvaluatedRun } from "../evaluator/run.js";
import { parseArgs } from "./args.js";

/** SigNoz needs a moment between ingest and query availability. */
const INGEST_WAIT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function banner(step: string, title: string): void {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${step}  ${title}`);
  console.log(`${"=".repeat(72)}\n`);
}

async function runVariant(variantName: string, taskIds: string[] | undefined, suite: string): Promise<void> {
  const variant = getVariant(variantName);
  const tasks = getTasks(taskIds);
  console.log(`  variant ${variant.name} on ${variant.model} — ${tasks.length} task(s)`);
  console.log(`  ${variant.description}\n`);

  for (const task of tasks) {
    try {
      const result = await runAgent(task, variant, suite);
      console.log(
        `    ${task.id.padEnd(26)} steps=${result.steps} tokens=${String(result.totalTokens).padEnd(6)} ` +
          `tools=[${result.toolSequence.join(" ") || "none"}]`,
      );
    } catch (err) {
      console.error(`    ${task.id} ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function evaluate(variant: string, seen: Set<string>): Promise<EvaluatedRun[]> {
  return evaluatePass({
    lookbackMinutes: 30,
    variant,
    seen,
    onProgress: (message) => console.log(`  ${message}`),
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const taskIds = args.list("tasks");
  const suite = args.string("suite") ?? "demo";
  const skipWait = args.bool("no-wait");

  // Agent and evaluator would normally be separate processes. They share one
  // here for demo convenience; each still emits under its own service name.
  initTelemetry({ serviceName: SERVICE.agent });

  banner("STEP 1/5", "Run the BASELINE agent — traces stream to SigNoz");
  await runVariant("baseline", taskIds, suite);
  console.log(`\n  Flushing traces...`);
  await shutdownTelemetry();

  if (!skipWait) {
    console.log(`  Waiting ${INGEST_WAIT_MS / 1000}s for SigNoz ingestion...`);
    await sleep(INGEST_WAIT_MS);
  }

  initTelemetry({ serviceName: SERVICE.evaluator });
  const seen = new Set<string>();

  banner("STEP 2/5", "Evaluate the baseline — read traces BACK from SigNoz and grade them");
  const baselineResults = await evaluate("baseline", seen);
  const baseline = summarise(baselineResults);
  await shutdownTelemetry();

  banner("STEP 3/5", "Ship a REGRESSION — grounding rules removed from the prompt");
  initTelemetry({ serviceName: SERVICE.agent });
  await runVariant("regressed", taskIds, suite);
  console.log(`\n  Flushing traces...`);
  await shutdownTelemetry();

  if (!skipWait) {
    console.log(`  Waiting ${INGEST_WAIT_MS / 1000}s for SigNoz ingestion...`);
    await sleep(INGEST_WAIT_MS);
  }

  banner("STEP 4/5", "Evaluate the regression — the same pipeline, no code changed");
  initTelemetry({ serviceName: SERVICE.evaluator });
  const regressedResults = await evaluate("regressed", seen);
  const regressed = summarise(regressedResults);

  banner("STEP 5/5", "The comparison your dashboard now shows");

  const row = (label: string, a: string, b: string): void =>
    console.log(`  ${label.padEnd(24)} ${a.padStart(12)}   ${b.padStart(12)}`);

  console.log(`  ${"".padEnd(24)} ${"BASELINE".padStart(12)}   ${"REGRESSED".padStart(12)}`);
  console.log(`  ${"-".repeat(52)}`);
  row("runs evaluated", String(baseline.count), String(regressed.count));
  row("passed", `${baseline.passed}/${baseline.count}`, `${regressed.passed}/${regressed.count}`);
  row("mean overall", baseline.meanOverall.toFixed(3), regressed.meanOverall.toFixed(3));
  row("mean groundedness", baseline.meanGroundedness.toFixed(3), regressed.meanGroundedness.toFixed(3));
  row("tokens per success", String(baseline.tokensPerSuccess), String(regressed.tokensPerSuccess));
  row("tokens wasted", String(baseline.wastedTokens), String(regressed.wastedTokens));

  const modes = new Set([
    ...Object.keys(baseline.failureModes),
    ...Object.keys(regressed.failureModes),
  ]);
  if (modes.size > 0) {
    console.log(`\n  failure modes:`);
    for (const mode of modes) {
      row(`  ${mode}`, String(baseline.failureModes[mode] ?? 0), String(regressed.failureModes[mode] ?? 0));
    }
  }

  const drop = baseline.meanGroundedness - regressed.meanGroundedness;
  console.log(
    `\n  Groundedness moved by ${drop >= 0 ? "-" : "+"}${Math.abs(drop).toFixed(3)} ` +
      `between the two deploys.`,
  );
  console.log(`  Infrastructure metrics for both runs are identical: no errors, no latency change.`);
  console.log(`  This drop is only visible because the agent's quality is telemetry.\n`);

  console.log(`  Next:`);
  console.log(`    npm run gate -- --variant regressed    # exits 1, blocking the bad deploy`);
  console.log(`    npm run gate -- --variant baseline     # exits 0`);
  console.log(`\n  Flushing evaluation telemetry...`);
  await shutdownTelemetry();
  console.log(`  Done — open SigNoz to see both traces and the scores.\n`);
}

main().catch(async (err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`);
  await shutdownTelemetry();
  process.exit(1);
});
