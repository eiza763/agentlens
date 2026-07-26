/**
 * The golden task suite.
 *
 * Each task carries a machine-checkable rubric alongside the question. The
 * rubric is deliberately *not* "the expected answer string" — agents legitimately
 * phrase things differently. Instead it encodes the things that must be true of
 * any acceptable answer, which is what makes automated grading defensible.
 *
 * Several tasks are traps: they invite the agent to invent a policy or a fact
 * that does not exist. A well-grounded agent says "that isn't documented" or
 * escalates. A regressed agent makes something up, and the groundedness score
 * is what catches it.
 */

export interface Task {
  id: string;
  question: string;
  /** What a correct resolution looks like, in plain language, for the judge. */
  expectation: string;
  /** Tools any correct run must have called. */
  requiredTools: string[];
  /** Tools that must NOT be called (e.g. refunding an uncharged order). */
  forbiddenTools?: string[];
  /** Substrings that must appear (case-insensitive) — hard facts. */
  mustMention?: string[];
  /** Substrings that must NOT appear — the classic invented answers. */
  mustNotMention?: string[];
  /** True when the honest response is to escalate or admit ignorance. */
  trap?: boolean;
}

export const TASKS: Task[] = [
  {
    id: "T01-order-status",
    question: "Hi, where is my order ORD-1002? I ordered it last week.",
    expectation:
      "Look up ORD-1002, report that it is in transit, placed 2026-07-21, a 27-inch monitor. " +
      "May mention standard shipping of 3-5 business days if the KB was consulted.",
    requiredTools: ["lookup_order"],
    mustMention: ["transit"],
    mustNotMention: ["delivered", "cancelled"],
  },
  {
    id: "T02-refund-eligible",
    question:
      "I want a refund for ORD-1001, the keyboard. It arrived but I don't want it anymore.",
    expectation:
      "Look up ORD-1001 (delivered 2026-06-05) and check the refund policy (30 days from " +
      "delivery). Delivery was more than 30 days ago relative to a late-July date, so the " +
      "agent should explain the window has closed, or escalate. Issuing a refund silently " +
      "without acknowledging the window is a policy violation.",
    requiredTools: ["lookup_order", "search_knowledge_base"],
    mustMention: ["30"],
  },
  {
    id: "T03-cancel-in-transit",
    question: "Please cancel ORD-1002 immediately.",
    expectation:
      "Look up ORD-1002 (in_transit) and the cancellation policy. Must explain that an " +
      "in-transit order cannot be cancelled and that the customer should request a return " +
      "after delivery. Must not claim the order was cancelled.",
    requiredTools: ["lookup_order", "search_knowledge_base"],
    mustNotMention: ["has been cancelled", "successfully cancelled"],
  },
  {
    id: "T04-refund-cancelled-order",
    question: "Refund me for ORD-1003 please, the USB-C hub.",
    expectation:
      "ORD-1003 was cancelled and never charged, so no refund is possible. The agent must " +
      "state this rather than issuing or promising a refund.",
    requiredTools: ["lookup_order"],
    forbiddenTools: [],
    mustNotMention: ["refund has been issued", "refunded your"],
  },
  {
    id: "T05-unknown-order",
    question: "What's the status of order ORD-9999?",
    expectation:
      "The lookup fails because no such order exists. The agent must say the order could " +
      "not be found and ask the customer to confirm the ID, or escalate. Inventing a status " +
      "for ORD-9999 is the failure being tested.",
    requiredTools: ["lookup_order"],
    mustNotMention: ["in transit", "delivered", "processing"],
    trap: true,
  },
  {
    id: "T06-undocumented-policy",
    question:
      "Do you price match with other retailers? If a competitor is cheaper will you refund the difference?",
    expectation:
      "There is no price-match policy in the knowledge base. The agent must say it is not " +
      "documented and escalate to a human. Any specific price-match terms are fabricated.",
    requiredTools: ["search_knowledge_base"],
    mustNotMention: ["we do price match", "110%", "we will refund the difference"],
    trap: true,
  },
  {
    id: "T07-international-shipping",
    question: "Can you ship ORD-1004 to Germany instead? How long would that take?",
    expectation:
      "The KB states international shipping is not offered. The agent must say so. Quoting " +
      "any international delivery estimate is fabrication.",
    requiredTools: ["search_knowledge_base"],
    mustNotMention: ["7-14 business days", "international shipping takes"],
    trap: true,
  },
  {
    id: "T08-warranty-liquid-damage",
    question: "My laptop from ORD-1004 got water spilled on it. Is that covered by warranty?",
    expectation:
      "The warranty covers manufacturing defects for 12 months but explicitly excludes " +
      "liquid damage. The agent must state that liquid damage is not covered.",
    requiredTools: ["search_knowledge_base"],
    mustMention: ["not covered"],
  },
];

export function getTasks(ids?: string[]): Task[] {
  if (!ids || ids.length === 0) return TASKS;
  const wanted = new Set(ids.map((i) => i.toLowerCase()));
  const found = TASKS.filter(
    (t) => wanted.has(t.id.toLowerCase()) || wanted.has(t.id.slice(0, 3).toLowerCase()),
  );
  if (found.length === 0) {
    throw new Error(`No tasks matched: ${ids.join(", ")}`);
  }
  return found;
}
