import { SpanStatusCode } from "@opentelemetry/api";
import { tracer } from "../telemetry/otel.js";
import { AGENTLENS, GENAI, GENAI_OP } from "../telemetry/genai.js";
import type { ToolSpec } from "../llm/client.js";
import { ORDERS, searchKb } from "./backend.js";

export const TOOL_DEFS: ToolSpec[] = [
  {
    name: "lookup_order",
    description:
      "Look up a customer order by its ID. Returns status, dates, item and total. " +
      "Use this before making any claim about a specific order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order ID, e.g. ORD-1002" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Search the support knowledge base for policy information (refunds, shipping, " +
      "warranty, cancellation). Use this before stating any policy.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What policy to look up" },
      },
      required: ["query"],
    },
  },
  {
    name: "issue_refund",
    description:
      "Issue a refund for an order. Only call this when the knowledge base and the " +
      "order status together confirm the customer is eligible.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        amount_usd: { type: "number" },
        reason: { type: "string" },
      },
      required: ["order_id", "amount_usd", "reason"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human agent. Use when the request needs a decision " +
      "outside documented policy, or when required information is unavailable.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
];

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

function run(name: string, input: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case "lookup_order": {
      const id = String(input.order_id ?? "").toUpperCase().trim();
      const order = ORDERS[id];
      if (!order) {
        return {
          content: `No order found with ID "${id}". Do not guess its contents.`,
          isError: true,
        };
      }
      return { content: JSON.stringify(order), isError: false };
    }

    case "search_knowledge_base": {
      const hits = searchKb(String(input.query ?? ""));
      if (hits.length === 0) {
        return {
          content:
            "No knowledge base article matches that query. There is no documented " +
            "policy on this topic. Do not invent one.",
          isError: false,
        };
      }
      return {
        content: JSON.stringify(hits.map((h) => ({ id: h.id, title: h.title, body: h.body }))),
        isError: false,
      };
    }

    case "issue_refund": {
      const id = String(input.order_id ?? "").toUpperCase().trim();
      const order = ORDERS[id];
      if (!order) {
        return { content: `Cannot refund unknown order "${id}".`, isError: true };
      }
      if (order.status === "cancelled") {
        return {
          content: `Order ${id} was cancelled and never charged; no refund is possible.`,
          isError: true,
        };
      }
      const amount = Number(input.amount_usd ?? 0);
      if (amount > order.total) {
        return {
          content: `Refund of $${amount} exceeds order total $${order.total}. Rejected.`,
          isError: true,
        };
      }
      return {
        content: JSON.stringify({ refund_id: `RF-${id.slice(4)}`, order_id: id, amount_usd: amount, status: "issued" }),
        isError: false,
      };
    }

    case "escalate_to_human": {
      return {
        content: JSON.stringify({
          ticket: "ESC-4471",
          status: "queued",
          reason: String(input.reason ?? ""),
        }),
        isError: false,
      };
    }

    default:
      return { content: `Unknown tool "${name}".`, isError: true };
  }
}

/**
 * Execute a tool inside its own span.
 *
 * Every field the evaluator later needs — which tool, with what arguments, and
 * what came back — is recorded as a span attribute. The trace is the only record
 * of the run; nothing is written to a side channel.
 */
export function executeTool(
  name: string,
  callId: string,
  input: Record<string, unknown>,
  ctx: { runId: string; taskId: string; variant: string; step: number },
): ToolOutcome {
  return tracer().startActiveSpan(`${GENAI_OP.EXECUTE_TOOL} ${name}`, (span) => {
    span.setAttributes({
      [GENAI.OPERATION_NAME]: GENAI_OP.EXECUTE_TOOL,
      [GENAI.TOOL_NAME]: name,
      [GENAI.TOOL_CALL_ID]: callId,
      [AGENTLENS.RUN_ID]: ctx.runId,
      [AGENTLENS.TASK_ID]: ctx.taskId,
      [AGENTLENS.VARIANT]: ctx.variant,
      [AGENTLENS.STEP]: ctx.step,
      "agentlens.tool.input": JSON.stringify(input),
    });

    try {
      const outcome = run(name, input);
      span.setAttribute("agentlens.tool.output", outcome.content.slice(0, 4000));
      span.setAttribute(AGENTLENS.TOOL_ERROR, outcome.isError);
      if (outcome.isError) {
        // A rejected tool call is a real signal, not a crash: it usually means
        // the agent tried something the business rules forbid.
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.content.slice(0, 200) });
      }
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.setAttribute(AGENTLENS.TOOL_ERROR, true);
      return { content: `Tool crashed: ${message}`, isError: true };
    } finally {
      span.end();
    }
  });
}
