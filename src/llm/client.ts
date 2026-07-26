/**
 * Provider-agnostic LLM client.
 *
 * Every provider this project supports — Groq, Google Gemini, OpenRouter,
 * Anthropic, Ollama — exposes an OpenAI-compatible chat-completions endpoint, so
 * one client covers all of them. Switching providers is an env-var change, not a
 * code change.
 *
 * That matters here for a practical reason: the free tiers are what make this
 * project runnable without a credit card, and being locked to one vendor would
 * mean being locked to that vendor's billing.
 */
import OpenAI from "openai";
import { config, provider } from "../config.js";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  model: string;
  id: string;
}

/** Message shape we pass around; mirrors the OpenAI wire format. */
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

let client: OpenAI | undefined;

function openai(): OpenAI {
  client ??= new OpenAI({
    apiKey: config.llmApiKey,
    baseURL: provider().baseUrl,
    // Free tiers rate-limit aggressively; a couple of retries turns a 429 into a
    // slightly slower run rather than a failed demo.
    maxRetries: 4,
  });
  return client;
}

function toOpenAiTools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Smaller models occasionally emit malformed JSON. Returning {} lets the tool
    // layer reject it with a useful message instead of crashing the run — and the
    // bad call is still recorded in the trace, which is the point.
    return {};
  }
}

export interface ChatOptions {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  /** Force a specific tool call — used by the judge for structured output. */
  forceTool?: string;
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
  };

  if (opts.tools && opts.tools.length > 0) {
    request.tools = toOpenAiTools(opts.tools);
    request.tool_choice = opts.forceTool
      ? { type: "function", function: { name: opts.forceTool } }
      : "auto";
  }

  const response = await openai().chat.completions.create(request);
  const choice = response.choices[0];
  const message = choice?.message;

  const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
    .filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
      call.type === "function",
    )
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      args: parseArgs(call.function.arguments),
    }));

  return {
    text: (message?.content ?? "").trim(),
    toolCalls,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    finishReason: choice?.finish_reason ?? "unknown",
    model: response.model ?? opts.model,
    id: response.id ?? "",
  };
}

/** Re-export the raw assistant message so callers can append it to history. */
export function assistantMessage(result: ChatResult): Message {
  if (result.toolCalls.length === 0) {
    return { role: "assistant", content: result.text };
  }
  return {
    role: "assistant",
    content: result.text || null,
    tool_calls: result.toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  };
}

export function toolResultMessage(callId: string, content: string): Message {
  return { role: "tool", tool_call_id: callId, content };
}
