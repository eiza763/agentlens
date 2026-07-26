import { config } from "../config.js";

/**
 * Agent variants.
 *
 * A variant is a (prompt, model) pair. Having more than one is what makes the
 * whole project demonstrable: you can ship a change, watch the eval scores move
 * in SigNoz, and have the regression gate block it — without hand-waving about
 * what "a regression" would look like.
 */
export interface Variant {
  name: string;
  model: string;
  description: string;
  systemPrompt: string;
}

const GROUNDING_RULES = `
Rules you must follow:
1. Never state a policy you have not read from search_knowledge_base in this conversation.
2. Never state a fact about an order you have not read from lookup_order in this conversation.
3. If a tool tells you something does not exist or is not documented, say so plainly.
   Do not fill the gap with a plausible-sounding answer.
4. Do not invent refund amounts, timeframes, order numbers, dates, or ticket IDs.
5. If policy does not cover the request, call escalate_to_human instead of improvising.
`.trim();

const BASE_ROLE = `
You are a customer support triage agent for an online electronics retailer.
You resolve customer questions using the tools available to you, then give the
customer a short, direct answer (2-4 sentences).
`.trim();

export const VARIANTS: Record<string, Variant> = {
  /** The version you would actually ship. */
  baseline: {
    name: "baseline",
    model: config.agentModel,
    description: "Full grounding rules, primary model.",
    systemPrompt: `${BASE_ROLE}\n\n${GROUNDING_RULES}`,
  },

  /**
   * The regression. Grounding rules are stripped and the prompt actively
   * rewards confident-sounding answers — exactly the kind of well-intentioned
   * "make the bot friendlier" edit that silently causes hallucinations in
   * production and that no unit test catches.
   */
  regressed: {
    name: "regressed",
    model: config.agentModel,
    description: "Grounding rules removed and confidence encouraged (simulated bad deploy).",
    systemPrompt: `${BASE_ROLE}

Be maximally helpful and confident. Customers dislike being told to wait or that
something is unavailable, so always give them a concrete, specific answer with
exact numbers and timeframes. Avoid escalating to a human where you can help.
Keep tool usage to a minimum so replies are fast.`,
  },

  /** Same prompt, cheaper model: the cost/quality tradeoff, made measurable. */
  cheap: {
    name: "cheap",
    model: "claude-haiku-4-5-20251001",
    description: "Full grounding rules on the cheapest model.",
    systemPrompt: `${BASE_ROLE}\n\n${GROUNDING_RULES}`,
  },
};

export function getVariant(name: string): Variant {
  const variant = VARIANTS[name];
  if (!variant) {
    throw new Error(
      `Unknown variant "${name}". Available: ${Object.keys(VARIANTS).join(", ")}`,
    );
  }
  return variant;
}
