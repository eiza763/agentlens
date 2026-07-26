/**
 * Regression gate.
 *
 * Queries the evaluation scores that the evaluator wrote into SigNoz and exits
 * non-zero when quality is below threshold. This is the step that turns agent
 * quality into something CI can block on, the same way it blocks on a failing
 * unit test — except the source of truth is production telemetry.
 *
 *   npm run gate
 *   npm run gate -- --variant regressed --lookback 60
 *   npm run gate -- --min-score 0.8
 *
 * Exit codes:  0 = quality acceptable, 1 = regression detected, 2 = no data.
 */
import { config, SERVICE, SPAN } from "../config.js";
import { AGENTLENS } from "../telemetry/genai.js";
import { queryScalar } from "../signoz/client.js";
import { parseArgs } from "./args.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lookbackMinutes = args.number("lookback") ?? 60;
  const variant = args.string("variant");
  const minScore = args.number("min-score") ?? config.scoreThreshold;
  const maxTokensPerRun = args.number("max-tokens") ?? config.tokensPerSuccessThreshold;

  const endMs = Date.now();
  const startMs = endMs - lookbackMinutes * 60_000;

  const clauses = [
    `service.name = '${SERVICE.evaluator}'`,
    `name = '${SPAN.evaluation}'`,
  ];
  if (variant) clauses.push(`${AGENTLENS.VARIANT} = '${variant}'`);
  const expression = clauses.join(" AND ");

  console.log(`\nAgentLens — regression gate`);
  console.log(`  window     : last ${lookbackMinutes} min${variant ? `, variant=${variant}` : ""}`);
  console.log(`  min score  : ${minScore}`);
  console.log(`  max tokens : ${maxTokensPerRun} per run\n`);

  const [evaluated, meanScore, meanGroundedness, failures, meanTokens] = await Promise.all([
    queryScalar({ expression, aggregation: "count()", startMs, endMs }),
    queryScalar({
      expression,
      aggregation: `avg(${AGENTLENS.EVAL_SCORE_OVERALL})`,
      startMs,
      endMs,
    }),
    queryScalar({
      expression,
      aggregation: `avg(${AGENTLENS.EVAL_SCORE_GROUNDEDNESS})`,
      startMs,
      endMs,
    }),
    queryScalar({
      expression: `${expression} AND ${AGENTLENS.EVAL_VERDICT} = 'fail'`,
      aggregation: "count()",
      startMs,
      endMs,
    }),
    queryScalar({
      expression,
      aggregation: `avg(${AGENTLENS.TOKENS_TOTAL})`,
      startMs,
      endMs,
    }),
  ]);

  if (!evaluated || evaluated === 0 || meanScore === null) {
    console.error(`  NO DATA — no evaluations found in SigNoz for this window.`);
    console.error(`  Run \`npm run agent\` then \`npm run eval\` first.`);
    console.error(`  (Set AGENTLENS_DEBUG=1 to inspect the raw query response.)\n`);
    process.exit(2);
  }

  const failed = failures ?? 0;
  const failRate = evaluated > 0 ? failed / evaluated : 0;

  console.log(`  evaluations       : ${evaluated}`);
  console.log(`  mean overall      : ${meanScore.toFixed(3)}   (threshold ${minScore})`);
  if (meanGroundedness !== null) {
    console.log(`  mean groundedness : ${meanGroundedness.toFixed(3)}`);
  }
  console.log(`  failed runs       : ${failed} (${(failRate * 100).toFixed(0)}%)`);
  if (meanTokens !== null) {
    console.log(`  mean tokens/run   : ${Math.round(meanTokens)}   (threshold ${maxTokensPerRun})`);
  }

  const violations: string[] = [];
  if (meanScore < minScore) {
    violations.push(
      `mean overall score ${meanScore.toFixed(3)} is below the threshold of ${minScore}`,
    );
  }
  if (meanTokens !== null && meanTokens > maxTokensPerRun) {
    violations.push(
      `mean tokens per run ${Math.round(meanTokens)} exceeds the budget of ${maxTokensPerRun}`,
    );
  }

  if (violations.length > 0) {
    console.error(`\n  REGRESSION DETECTED`);
    for (const v of violations) console.error(`    - ${v}`);
    console.error(`\n  Blocking the build.\n`);
    process.exit(1);
  }

  console.log(`\n  PASS — agent quality is within thresholds.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
