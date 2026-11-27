import { Env, ChatMessage } from "./types";

const MAX_BODY_BYTES = 20_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_TOTAL_CHARS = 16_000;
const DEFAULT_MAX_TOKENS = 700;
const MAX_RESPONSE_BYTES = 16_000;
const MODEL_ID = "@cf/qwen/qwen3.8-27b";

type OmaMessage = { role: "system" | "user" | "assistant"; content: string };
type OmaPayload = { messages: OmaMessage[]; maxTokens: number };

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

export function validateOmaPayload(value: unknown): OmaPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as { messages?: unknown; maxTokens?: unknown };
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_MESSAGES) return null;

  const messages: OmaMessage[] = [];
  let totalChars = 0;
  let hasUserMessage = false;
  for (const item of body.messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const message = item as { role?: unknown; content?: unknown };
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") return null;
    if (typeof message.content !== "string" || message.content.trim().length === 0 || message.content.length > MAX_MESSAGE_CHARS) return null;
    totalChars += message.content.length;
    if (totalChars > MAX_TOTAL_CHARS) return null;
    if (message.role === "user") hasUserMessage = true;
    messages.push({ role: message.role, content: message.content });
  }
  if (!hasUserMessage) return null;

  const maxTokens = body.maxTokens === undefined ? DEFAULT_MAX_TOKENS : body.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 1_400) return null;
  return { messages, maxTokens };
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

/** Text-only OMA adapter. It intentionally has no access to D1 memory or tools. */
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
  const rawBody = new TextDecoder().decode(bodyBytes);

  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); }
  catch { return json({ error: "Invalid JSON." }, 400); }
  const payload = validateOmaPayload(parsed);
  if (!payload) return json({ error: "Invalid OMA messages or token limit." }, 400);

  try {
    const startedAt = Date.now();
    const result = await env.AI.run<typeof MODEL_ID>(MODEL_ID, {
      messages: payload.messages as ChatMessage[],
      max_completion_tokens: payload.maxTokens,
      reasoning_effort: "low",
      stream: false,
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
    }) as {
      response?: string;
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const value = result.choices?.[0]?.message?.content;
    const content = (typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("") : result.response ?? "").trim();
    if (!content) {
      console.error("JARVIS_OMA_EMPTY_RESPONSE");
      return json({ error: "AI returned an empty response." }, 502);
    }

    const promptTokens = result.usage?.prompt_tokens ?? estimateTokens(payload.messages.map(message => message.content).join("\\n"));
    const completionTokens = result.usage?.completion_tokens ?? estimateTokens(content);
    const response = {
      id: crypto.randomUUID(),
      model: MODEL_ID,
      content: [{ type: "text", text: boundedText(content, 12_000) }],
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
      },
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
