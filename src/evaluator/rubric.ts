/**
 * Deterministic checks.
 *
 * An LLM judge is good at "was this answer actually helpful and grounded?" and
 * bad at being reproducible. Hard rules are the opposite. AgentLens runs both and
 * reports them separately, so a regression always has at least one explanation
 * that does not depend on a model's opinion.
 */
import type { Task } from "../agent/tasks.js";
import type { ReconstructedRun } from "./reconstruct.js";

export interface RubricResult {
  pass: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
}

export function applyRubric(run: ReconstructedRun, task: Task | undefined): RubricResult {
  const checks: RubricResult["checks"] = [];
  const answer = run.answer.toLowerCase();
  const calledTools = new Set(run.toolCalls.map((t) => t.name));

  checks.push({
    name: "produced_answer",
    pass: run.answer.trim().length > 0,
    detail: run.answer.trim().length > 0 ? "Agent produced an answer." : "Agent produced no answer.",
  });

  if (!task) {
    return { pass: checks.every((c) => c.pass), checks };
  }

  for (const tool of task.requiredTools) {
    const pass = calledTools.has(tool);
    checks.push({
      name: `required_tool:${tool}`,
      pass,
      detail: pass ? `Called ${tool}.` : `Never called ${tool}, which this task requires.`,
    });
  }

  for (const tool of task.forbiddenTools ?? []) {
    const pass = !calledTools.has(tool);
    checks.push({
      name: `forbidden_tool:${tool}`,
      pass,
      detail: pass ? `Correctly avoided ${tool}.` : `Called forbidden tool ${tool}.`,
    });
  }

  for (const phrase of task.mustMention ?? []) {
    const pass = answer.includes(phrase.toLowerCase());
    checks.push({
      name: `must_mention:${phrase}`,
      pass,
      detail: pass ? `Answer mentions "${phrase}".` : `Answer omits required detail "${phrase}".`,
    });
  }

  for (const phrase of task.mustNotMention ?? []) {
    const pass = !answer.includes(phrase.toLowerCase());
    checks.push({
      name: `must_not_mention:${phrase}`,
      pass,
      detail: pass
        ? `Answer avoids "${phrase}".`
        : `Answer contains "${phrase}", which is false for this task.`,
    });
  }

  // Tool calls the business rules rejected are worth surfacing on their own:
  // they mean the agent tried to do something it was not allowed to do.
  const rejected = run.toolCalls.filter((t) => t.isError);
  if (rejected.length > 0) {
    checks.push({
      name: "no_rejected_tool_calls",
      pass: false,
      detail: `${rejected.length} tool call(s) were rejected: ${rejected
        .map((t) => t.name)
        .join(", ")}.`,
    });
  }

  return { pass: checks.every((c) => c.pass), checks };
}

export function formatRubric(result: RubricResult): string {
  return result.checks
    .map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`)
    .join("\n");
}
