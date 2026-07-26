/**
 * Read agent runs back out of SigNoz, grade them, and write the scores back.
 *
 *   npm run eval                              # last 30 min, all variants
 *   npm run eval -- --lookback 120
 *   npm run eval -- --variant regressed
 *   npm run eval -- --watch                   # keep evaluating new runs
 */
import { initTelemetry, shutdownTelemetry } from "../telemetry/otel.js";
import { SERVICE, config } from "../config.js";
import { evaluatePass, summarise } from "../evaluator/run.js";
import { parseArgs } from "./args.js";

const WATCH_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lookbackMinutes = args.number("lookback") ?? 30;
  const variant = args.string("variant");
  const limit = args.number("limit") ?? 100;
  const watch = args.bool("watch");

  initTelemetry({ serviceName: SERVICE.evaluator });

  console.log(`\nAgentLens — evaluator`);
  console.log(`  source   : ${config.signozApiUrl}`);
  console.log(`  judge    : ${config.judgeModel}`);
  console.log(`  lookback : ${lookbackMinutes} min${variant ? `, variant=${variant}` : ""}\n`);

  const seen = new Set<string>();

  const pass = async (): Promise<void> => {
    const results = await evaluatePass({
      lookbackMinutes,
      variant,
      limit,
      seen,
      onProgress: (message) => console.log(message),
    });

    if (results.length === 0) return;

    const s = summarise(results);
    console.log(`\n  ---- summary ----`);
    console.log(`  evaluated          : ${s.count}`);
    console.log(`  passed / failed    : ${s.passed} / ${s.failed}`);
    console.log(`  mean overall       : ${s.meanOverall.toFixed(3)}`);
    console.log(`  mean groundedness  : ${s.meanGroundedness.toFixed(3)}`);
    console.log(`  tokens per success : ${s.tokensPerSuccess}`);
    console.log(`  tokens wasted      : ${s.wastedTokens} (spent on runs that failed)`);

    if (Object.keys(s.byVariant).length > 1) {
      console.log(`\n  by variant:`);
      for (const [name, bucket] of Object.entries(s.byVariant)) {
        console.log(
          `    ${name.padEnd(12)} n=${String(bucket.count).padEnd(4)} ` +
            `mean=${bucket.meanOverall.toFixed(3)} passed=${bucket.passed}/${bucket.count}`,
        );
      }
    }

    if (Object.keys(s.failureModes).length > 0) {
      console.log(`\n  failure modes:`);
      for (const [mode, n] of Object.entries(s.failureModes).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${mode.padEnd(26)} ${n}`);
      }
    }

    // Show the reasoning for failures: this is the line that makes the demo land,
    // because it names the invented fact in plain language.
    const failures = results.filter((r) => r.judgement.verdict === "fail");
    if (failures.length > 0) {
      console.log(`\n  why runs failed:`);
      for (const f of failures.slice(0, 6)) {
        console.log(`\n    ${f.run.taskId} [${f.run.variant}] ${f.judgement.failure_mode}`);
        console.log(`      ${f.judgement.reasoning.replace(/\n/g, "\n      ")}`);
        if (f.failedChecks.length > 0) {
          console.log(`      failed checks: ${f.failedChecks.join(", ")}`);
        }
      }
    }
    console.log("");
  };

  await pass();

  if (watch) {
    console.log(`Watching for new runs every ${WATCH_INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);
    const timer = setInterval(() => {
      pass().catch((err) => console.error(`pass failed: ${err instanceof Error ? err.message : err}`));
    }, WATCH_INTERVAL_MS);

    const stop = async (): Promise<void> => {
      clearInterval(timer);
      await shutdownTelemetry();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    return;
  }

  console.log(`Flushing evaluation telemetry to SigNoz...`);
  await shutdownTelemetry();
  console.log(`Done. Scores are now queryable in SigNoz.\n`);
}

main().catch(async (err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`);
  await shutdownTelemetry();
  process.exit(1);
});
