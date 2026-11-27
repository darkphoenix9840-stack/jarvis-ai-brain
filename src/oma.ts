import { Env, ChatMessage } from "./types";

const MAX_BODY_BYTES = 20_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_TOTAL_CHARS = 16_000;
const DEFAULT_MAX_TOKENS = 700;
const MAX_RESPONSE_BYTES = 16_000;
const MAX_TOOLS = 8;
const MAX_TOOL_SCHEMA_BYTES = 8_192;
const MAX_TOOL_CALLS = 4;
const MODEL_ID = "@cf/qwen/qwen3.8-27b";

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string | TextBlock[]; is_error?: boolean };
type OmaContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
type OmaMessage = { role: "system" | "user" | "assistant"; content: string | OmaContentBlock[] };
type OmaTool = { name: string; description: string; input_schema: Record<string, unknown> };
type OmaPayload = { messages: OmaMessage[]; maxTokens: number; tools: OmaTool[]; toolChoice: "auto" | "none" };

type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Vary": "Origin",
    },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

export function isOmaAuthorized(request: Request, configuredToken?: string): boolean {
  if (!configuredToken || configuredToken.length < 24) return false;
  const match = /^Bearer ([^\\s]+)$/i.exec(request.headers.get("Authorization") ?? "");
  return Boolean(match && constantTimeEqual(match[1], configuredToken));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textFromToolResult(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return null;
    parts.push(part.text);
  }
  return parts.join("\\n");
}

function validateMessage(value: unknown): OmaMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role;
  const content = value.content;
  if (role !== "system" && role !== "user" && role !== "assistant") return null;
  if (typeof content === "string") {
    if (!content.trim() || content.length > MAX_MESSAGE_CHARS) return null;
    return { role, content };
  }
  if (role === "system" || !Array.isArray(content) || content.length < 1 || content.length > 16) return null;

  const blocks: OmaContentBlock[] = [];
  let chars = 0;
  for (const item of content) {
    if (!isRecord(item)) return null;
    if (item.type === "text" && typeof item.text === "string") {
      chars += item.text.length;
      if (item.text.length > MAX_MESSAGE_CHARS) return null;
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    if (role === "assistant" && item.type === "tool_use") {
      if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id)) return null;
      if (typeof item.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.name)) return null;
      if (!isRecord(item.input)) return null;
      const serialized = JSON.stringify(item.input);
      if (serialized.length > MAX_TOOL_SCHEMA_BYTES) return null;
      chars += serialized.length;
      blocks.push({ type: "tool_use", id: item.id, name: item.name, input: item.input });
      continue;
    }
    if (role === "user" && item.type === "tool_result") {
      if (typeof item.tool_use_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.tool_use_id)) return null;
      const resultText = textFromToolResult(item.content);
      if (resultText === null || resultText.length > MAX_MESSAGE_CHARS) return null;
      chars += resultText.length;
      blocks.push({
        type: "tool_result",
        tool_use_id: item.tool_use_id,
        content: resultText,
        ...(item.is_error === true ? { is_error: true } : {}),
      });
      continue;
    }
    return null;
  }
  if (chars > MAX_MESSAGE_CHARS) return null;
  return { role, content: blocks };
}

function validateTools(value: unknown): OmaTool[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return null;
  const tools: OmaTool[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) ||
      typeof item.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(item.name) ||
      names.has(item.name) ||
      typeof item.description !== "string" ||
      item.description.trim().length < 1 ||
      item.description.length > 1_000 ||
      !isRecord(item.input_schema) ||
      item.input_schema.type !== "object") return null;
    if (JSON.stringify(item.input_schema).length > MAX_TOOL_SCHEMA_BYTES) return null;
    names.add(item.name);
    tools.push({
      name: item.name,
      description: item.description,
      input_schema: item.input_schema,
    });
  }
  return tools;
}

export function validateOmaPayload(value: unknown): OmaPayload | null {
  if (!isRecord(value) || !Array.isArray(value.messages) ||
    value.messages.length < 1 || value.messages.length > MAX_MESSAGES) return null;

  const messages: OmaMessage[] = [];
  let totalChars = 0;
  let hasUserMessage = false;
  for (const item of value.messages) {
    const message = validateMessage(item);
    if (!message) return null;
    const size = typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
    totalChars += size;
    if (totalChars > MAX_TOTAL_CHARS) return null;
    if (message.role === "user") hasUserMessage = true;
    messages.push(message);
  }
  if (!hasUserMessage) return null;

  const maxTokens = value.maxTokens === undefined ? DEFAULT_MAX_TOKENS : value.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 1_400) return null;
  const tools = validateTools(value.tools);
  if (!tools) return null;
  const toolChoice = value.tool_choice === undefined ? "auto" : value.tool_choice;
  if (toolChoice !== "auto" && toolChoice !== "none") return null;
  if (toolChoice === "auto" && tools.length === 0 && value.tool_choice !== undefined) return null;
  return { messages, maxTokens, tools, toolChoice };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function boundedText(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function toModelMessages(messages: OmaMessage[]): ModelMessage[] {
  const output: ModelMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      output.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map(block => block.text)
        .join("\\n");
      const calls = message.content
        .filter((block): block is ToolUseBlock => block.type === "tool_use")
        .map(block => ({
          id: block.id,
          type: "function" as const,
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }));
      output.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const text = message.content
      .filter((block): block is TextBlock => block.type === "text")
      .map(block => block.text)
      .join("\\n");
    if (text) output.push({ role: "user", content: text });
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      output.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: typeof block.content === "string" ? block.content : textFromToolResult(block.content) ?? "",
      });
    }
  }
  return output;
}

function parseToolCalls(value: unknown, allowedNames: Set<string>): ToolUseBlock[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) return null;
  const output: ToolUseBlock[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const fn = isRecord(item.function) ? item.function : item;
    const name = fn.name;
    const rawArgs = fn.arguments;
    if (typeof name !== "string" || !allowedNames.has(name)) return null;
    let input: unknown = rawArgs;
    if (typeof rawArgs === "string") {
      if (rawArgs.length > MAX_TOOL_SCHEMA_BYTES) return null;
      try { input = JSON.parse(rawArgs); } catch { return null; }
    } else if (!isRecord(rawArgs) || JSON.stringify(rawArgs).length > MAX_TOOL_SCHEMA_BYTES) {
      return null;
    }
    if (!isRecord(input)) return null;
    const id = typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(item.id)
      ? item.id
      : "call_" + crypto.randomUUID();
    output.push({ type: "tool_use", id, name, input });
  }
  return output;
}

/** Text/tool-call adapter. It returns tool requests to the local OMA client; it never executes tools. */
export async function handleOmaChatRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST request." }, 405);
  if (!env.JARVIS_OMA_TOKEN || env.JARVIS_OMA_TOKEN.length < 24) {
    return json({ error: "OMA endpoint is not configured." }, 503);
  }
  if (!isOmaAuthorized(request, env.JARVIS_OMA_TOKEN)) return json({ error: "Unauthorized." }, 401);

  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return json({ error: "Request body is too large." }, 413);
  if (!request.body) return json({ error: "Invalid request body." }, 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      receivedBytes += part.value.byteLength;
      if (receivedBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return json({ error: "Request body is too large." }, 413);
      }
      chunks.push(part.value);
    }
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const bodyBytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bodyBytes)); }
  catch { return json({ error: "Invalid JSON." }, 400); }
  const payload = validateOmaPayload(parsed);
  if (!payload) return json({ error: "Invalid OMA messages, tools, or token limit." }, 400);

  try {
    const startedAt = Date.now();
    const modelTools = payload.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
    const result = await env.AI.run<typeof MODEL_ID>(MODEL_ID, {
      messages: toModelMessages(payload.messages),
      max_completion_tokens: payload.maxTokens,
      reasoning_effort: "low",
      stream: false,
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
      ...(modelTools.length ? {
        tools: modelTools,
        tool_choice: payload.toolChoice,
        parallel_tool_calls: false,
      } : {}),
    } as never) as {
      response?: string;
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
          tool_calls?: unknown;
        };
      }>;
      tool_calls?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const message = result.choices?.[0]?.message;
    const value = message?.content;
    const text = (typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("") : result.response ?? "").trim();
    const toolUses = parseToolCalls(message?.tool_calls ?? result.tool_calls, new Set(payload.tools.map(tool => tool.name)));
    if (!toolUses) {
      console.error("JARVIS_OMA_INVALID_TOOL_CALL");
      return json({ error: "AI returned an invalid or unsupported tool call." }, 502);
    }
    if (!text && toolUses.length === 0) {
      console.error("JARVIS_OMA_EMPTY_RESPONSE");
      return json({ error: "AI returned an empty response." }, 502);
    }

    const content: Array<TextBlock | ToolUseBlock> = [];
    if (text) content.push({ type: "text", text: boundedText(text, 12_000) });
    content.push(...toolUses);
    const promptTokens = result.usage?.prompt_tokens ?? estimateTokens(payload.messages.map(item => typeof item.content === "string" ? item.content : JSON.stringify(item.content)).join("\\n"));
    const completionTokens = result.usage?.completion_tokens ?? estimateTokens(JSON.stringify(content));
    const response = {
      id: crypto.randomUUID(),
      model: MODEL_ID,
      content,
      stop_reason: toolUses.length ? "tool_use" : "end_turn",
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
    };
    if (new TextEncoder().encode(JSON.stringify(response)).byteLength > MAX_RESPONSE_BYTES) {
      return json({ error: "AI response is too large." }, 502);
    }
    console.log("JARVIS_OMA_LATENCY_MS:", Date.now() - startedAt);
    return json(response);
  } catch (error) {
    console.error("JARVIS_OMA_MODEL_ERROR:", error);
    return json({ error: "OMA model request failed." }, 502);
  }
}
