/**
 * Offline self-test. Runs with no credentials and no network.
 *
 * Covers the logic that would otherwise only be exercised against a live SigNoz
 * workspace — in particular the response-envelope parser, which has to tolerate
 * schema differences between SigNoz versions and is the most likely thing to
 * break on someone else's workspace.
 *
 *   npm run selftest
 */
import { extractRows, attr, numAttr } from "../signoz/client.js";
import { applyRubric } from "../evaluator/rubric.js";
import { renderTranscript, type ReconstructedRun } from "../evaluator/reconstruct.js";
import { parseArgs } from "./args.js";
import { TASKS, getTasks } from "../agent/tasks.js";
import { searchKb, groundTruthDigest } from "../agent/backend.js";
import { VARIANTS } from "../agent/variants.js";
import { PROVIDERS, provider } from "../config.js";
import { assistantMessage, toolResultMessage } from "../llm/client.js";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

console.log(`\nAgentLens — offline self-test\n`);

// --- SigNoz envelope parsing -------------------------------------------------
// Three shapes SigNoz has used across versions. All must yield flat rows.

const shapeA = {
  status: "success",
  data: {
    results: [
      {
        queryName: "A",
        rows: [
          { timestamp: 1, data: { trace_id: "abc", "agentlens.task.id": "T01-order-status" } },
          { timestamp: 2, data: { trace_id: "def", "agentlens.task.id": "T02-refund-eligible" } },
        ],
      },
    ],
  },
};

const shapeB = {
  data: {
    result: [
      {
        list: [
          { timestamp: "2026-07-26T00:00:00Z", data: { trace_id: "aaa", "agentlens.variant": "baseline" } },
        ],
      },
    ],
  },
};

const shapeC = {
  data: {
    results: [
      { trace_id: "flat1", "agentlens.eval.score.overall": 0.91 },
      { trace_id: "flat2", "agentlens.eval.score.overall": 0.44 },
    ],
  },
};

const rowsA = extractRows(shapeA);
check("extractRows: nested results/rows/data", rowsA.length === 2, `got ${rowsA.length}`);
check(
  "extractRows: flattens data bag to top level",
  rowsA[0]?.["agentlens.task.id"] === "T01-order-status",
  JSON.stringify(rowsA[0]),
);
check("extractRows: preserves timestamp", rowsA[0]?.timestamp === 1);

const rowsB = extractRows(shapeB);
check("extractRows: result/list/data shape", rowsB.length === 1, `got ${rowsB.length}`);
check("extractRows: reads attr from list shape", attr(rowsB[0] ?? {}, "agentlens.variant") === "baseline");

const rowsC = extractRows(shapeC);
check("extractRows: already-flat rows", rowsC.length === 2, `got ${rowsC.length}`);
check("extractRows: numeric attr read", numAttr(rowsC[1] ?? {}, "agentlens.eval.score.overall") === 0.44);

check("extractRows: empty response is empty array", extractRows({ data: {} }).length === 0);
check("extractRows: null-safe", extractRows(null).length === 0);

// attr() should fall back to nested attribute bags.
check(
  "attr: reads from nested attributes bag",
  attr({ attributes: { "agentlens.variant": "cheap" } }, "agentlens.variant") === "cheap",
);
check("attr: tolerates naming variants", attr({ traceId: "xyz" }, "trace_id", "traceId") === "xyz");
check("attr: missing returns undefined", attr({}, "nope") === undefined);

// --- Rubric ------------------------------------------------------------------

const baseRun: ReconstructedRun = {
  traceId: "0".repeat(31) + "1",
  spanId: "0".repeat(15) + "1",
  runId: "run-test",
  taskId: "T05-unknown-order",
  variant: "baseline",
  suite: "selftest",
  question: "What's the status of order ORD-9999?",
  answer: "I couldn't find an order with ID ORD-9999. Could you double-check the number?",
  toolCalls: [
    {
      name: "lookup_order",
      input: '{"order_id":"ORD-9999"}',
      output: 'No order found with ID "ORD-9999".',
      isError: true,
      step: 1,
    },
  ],
  steps: 2,
  inputTokens: 900,
  outputTokens: 60,
  totalTokens: 960,
  latencyMs: 2400,
  escalated: false,
};

const trapTask = TASKS.find((t) => t.id === "T05-unknown-order");
const goodRubric = applyRubric(baseRun, trapTask);
check(
  "rubric: honest 'not found' answer avoids forbidden phrases",
  goodRubric.checks.filter((c) => c.name.startsWith("must_not_mention")).every((c) => c.pass),
  goodRubric.checks.filter((c) => !c.pass).map((c) => c.name).join(", "),
);
check(
  "rubric: required tool detected",
  goodRubric.checks.some((c) => c.name === "required_tool:lookup_order" && c.pass),
);
check(
  "rubric: rejected tool call is surfaced",
  goodRubric.checks.some((c) => c.name === "no_rejected_tool_calls" && !c.pass),
);

const hallucinated: ReconstructedRun = {
  ...baseRun,
  answer: "Order ORD-9999 is currently in transit and should arrive in 2 business days.",
};
const badRubric = applyRubric(hallucinated, trapTask);
check(
  "rubric: catches invented status on trap task",
  badRubric.checks.some((c) => c.name === "must_not_mention:in transit" && !c.pass),
);
check("rubric: overall fails when a check fails", badRubric.pass === false);

const noAnswer = applyRubric({ ...baseRun, answer: "" }, trapTask);
check(
  "rubric: empty answer fails produced_answer",
  noAnswer.checks.some((c) => c.name === "produced_answer" && !c.pass),
);

// --- Transcript rendering ----------------------------------------------------

const transcript = renderTranscript(baseRun);
check("transcript: includes the question", transcript.includes("ORD-9999"));
check("transcript: includes the tool call", transcript.includes("lookup_order"));
check("transcript: flags tool errors for the judge", transcript.includes("[TOOL ERROR]"));
check("transcript: includes the final answer", transcript.includes("double-check"));

// --- Arg parsing -------------------------------------------------------------

const args = parseArgs(["--variant", "regressed", "--lookback=90", "--watch", "--tasks", "T05,T06"]);
check("args: --key value", args.string("variant") === "regressed");
check("args: --key=value", args.number("lookback") === 90);
check("args: bare flag", args.bool("watch") === true);
check("args: comma list", JSON.stringify(args.list("tasks")) === '["T05","T06"]');
check("args: missing flag is undefined", args.string("nope") === undefined);
check("args: unset bool is false", args.bool("nope") === false);

// --- Tasks and variants ------------------------------------------------------

check("tasks: suite is non-empty", TASKS.length >= 8, `got ${TASKS.length}`);
check("tasks: every task has an id and expectation", TASKS.every((t) => t.id && t.expectation));
check("tasks: at least three traps", TASKS.filter((t) => t.trap).length >= 3);
check("tasks: filter by short prefix", getTasks(["T05"]).length === 1);
check(
  "tasks: unknown filter throws",
  (() => {
    try {
      getTasks(["nope"]);
      return false;
    } catch {
      return true;
    }
  })(),
);

check("variants: baseline has grounding rules", (VARIANTS.baseline?.systemPrompt ?? "").includes("Never state a policy"));
check(
  "variants: regressed has grounding rules removed",
  !(VARIANTS.regressed?.systemPrompt ?? "").includes("Never state a policy"),
);
check("variants: cheap uses a different model", VARIANTS.cheap?.model !== VARIANTS.baseline?.model);

// --- Provider layer ----------------------------------------------------------

check("providers: at least one free-tier option", Object.values(PROVIDERS).some((p) => p.freeTier));
check(
  "providers: every preset has a base URL, key var and models",
  Object.values(PROVIDERS).every(
    (p) => p.baseUrl.startsWith("http") && p.keyVar.length > 0 && p.defaultAgentModel.length > 0 && p.defaultCheapModel.length > 0,
  ),
);
check(
  "providers: cheap model differs from agent model",
  Object.values(PROVIDERS).every((p) => p.defaultCheapModel !== p.defaultAgentModel),
);
check(
  "providers: unknown LLM_PROVIDER throws",
  (() => {
    const saved = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "definitely-not-a-provider";
    try {
      provider();
      return false;
    } catch {
      return true;
    } finally {
      if (saved === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = saved;
    }
  })(),
);

const textOnly = assistantMessage({
  text: "Your order is in transit.",
  toolCalls: [],
  inputTokens: 10,
  outputTokens: 5,
  finishReason: "stop",
  model: "m",
  id: "1",
});
check("client: text-only reply becomes a plain assistant message", textOnly.role === "assistant" && !("tool_calls" in textOnly));

const withTools = assistantMessage({
  text: "",
  toolCalls: [{ id: "call_1", name: "lookup_order", args: { order_id: "ORD-1002" } }],
  inputTokens: 10,
  outputTokens: 5,
  finishReason: "tool_calls",
  model: "m",
  id: "1",
});
check(
  "client: tool call is serialised back to the wire format",
  "tool_calls" in withTools &&
    JSON.parse((withTools.tool_calls?.[0] as { function: { arguments: string } }).function.arguments).order_id ===
      "ORD-1002",
);

const toolMsg = toolResultMessage("call_1", "result text");
check("client: tool result message carries the call id", toolMsg.role === "tool" && "tool_call_id" in toolMsg);

// --- Backend ground truth ----------------------------------------------------

check("kb: refund query hits the refund article", searchKb("can I get a refund").some((a) => a.id === "KB-REFUND-01"));
check("kb: unrelated query returns nothing", searchKb("do you sell bicycles in Peru").length === 0);
check("ground truth: enumerates orders and policies", groundTruthDigest().includes("ORD-1002") && groundTruthDigest().includes("KB-SHIP-01"));
check("ground truth: closes the world", groundTruthDigest().includes("no other orders"));

// -----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
