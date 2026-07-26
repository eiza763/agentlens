/**
 * Run the agent over the task suite and ship traces to SigNoz.
 *
 *   npm run agent                          # baseline variant, all tasks
 *   npm run agent -- --variant regressed   # the simulated bad deploy
 *   npm run agent -- --variant cheap
 *   npm run agent -- --tasks T05,T06       # just the traps
 */
import { initTelemetry, shutdownTelemetry } from "../telemetry/otel.js";
import { SERVICE } from "../config.js";
import { getTasks } from "../agent/tasks.js";
import { getVariant } from "../agent/variants.js";
import { runAgent } from "../agent/agent.js";
import { parseArgs } from "./args.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const variantName = args.string("variant") ?? "baseline";
  const suite = args.string("suite") ?? "golden-v1";
  const taskIds = args.list("tasks");

  const variant = getVariant(variantName);
  const tasks = getTasks(taskIds);

  initTelemetry({
    serviceName: SERVICE.agent,
    attributes: { "agentlens.variant": variant.name },
  });

  console.log(`\nAgentLens — running agent`);
  console.log(`  variant : ${variant.name} (${variant.description})`);
  console.log(`  model   : ${variant.model}`);
  console.log(`  suite   : ${suite}`);
  console.log(`  tasks   : ${tasks.length}\n`);

  let ok = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      const result = await runAgent(task, variant, suite);
      ok += 1;
      console.log(
        `  done  ${task.id.padEnd(26)} steps=${result.steps} tokens=${result.totalTokens} ` +
          `${result.latencyMs}ms tools=[${result.toolSequence.join(" ") || "none"}]`,
      );
      console.log(`        trace ${result.traceId}`);
    } catch (err) {
      failed += 1;
      console.error(`  ERROR ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${ok} run(s) completed, ${failed} errored.`);
  console.log(`Flushing telemetry to SigNoz...`);
  await shutdownTelemetry();
  console.log(`Done. Wait ~15s for ingestion, then: npm run eval\n`);
}

main().catch(async (err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`);
  await shutdownTelemetry();
  process.exit(1);
});
