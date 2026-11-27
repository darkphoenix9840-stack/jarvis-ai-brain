import { describe, expect, it, vi } from "vitest";
import { handleOmaChatRequest, isOmaAuthorized, validateOmaPayload } from "../src/oma";

const token = "test-token-that-is-at-least-24-characters";
const validBody = {
  messages: [
    { role: "system", content: "Reviewer role." },
    { role: "user", content: "Review this change." },
  ],
};
const wonkTool = {
  name: "wonk_search",
  description: "Search the local code index. Read-only.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
    required: ["query"],
    additionalProperties: false,
  },
};

function request(body: unknown, authorized = true): Request {
  return new Request("https://example.workers.dev/api/oma/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("OMA request validation", () => {
  it("accepts bounded role-preserving messages", () => {
    expect(validateOmaPayload(validBody)).toMatchObject({ maxTokens: 700, tools: [], toolChoice: "auto" });
  });
  it("rejects missing user messages and unsupported roles", () => {
    expect(validateOmaPayload({ messages: [{ role: "assistant", content: "hello" }] })).toBeNull();
    expect(validateOmaPayload({ messages: [{ role: "tool", content: "hello" }] })).toBeNull();
  });
  it("rejects oversized content, too many messages, and unsafe token limits", () => {
    expect(validateOmaPayload({ messages: [{ role: "user", content: "x".repeat(10_001) }] })).toBeNull();
    expect(validateOmaPayload({ messages: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) })).toBeNull();
    expect(validateOmaPayload({ messages: [{ role: "user", content: "hello" }], maxTokens: 10_000 })).toBeNull();
  });
  it("accepts only token limits from 64 through 1400", () => {
    expect(validateOmaPayload({ messages: [{ role: "user", content: "hello" }], maxTokens: 1000 })?.maxTokens).toBe(1000);
    expect(validateOmaPayload({ messages: [{ role: "user", content: "hello" }], maxTokens: 63 })).toBeNull();
  });
  it("accepts bounded, unique JSON-schema tools", () => {
    expect(validateOmaPayload({ ...validBody, tools: [wonkTool] })?.tools).toHaveLength(1);
    expect(validateOmaPayload({ ...validBody, tools: [wonkTool, wonkTool] })).toBeNull();
    expect(validateOmaPayload({ ...validBody, tools: [{ ...wonkTool, input_schema: { type: "string" } }] })).toBeNull();
    expect(validateOmaPayload({ ...validBody, tools: Array.from({ length: 9 }, (_, i) => ({ ...wonkTool, name: "tool_" + i })) })).toBeNull();
  });
  it("accepts assistant tool-use and user tool-result blocks", () => {
    const payload = {
      messages: [
        { role: "user", content: "Search the code." },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "wonk_search", input: { query: "Agent adapter" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Found two references." }] },
      ],
      tools: [wonkTool],
    };
    expect(validateOmaPayload(payload)).not.toBeNull();
  });
  it("rejects invalid tool results and unsupported tool choice", () => {
    expect(validateOmaPayload({
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "bad id", content: "x" }] }],
    })).toBeNull();
    expect(validateOmaPayload({ ...validBody, tools: [wonkTool], tool_choice: "required" })).toBeNull();
  });
});

describe("OMA bearer authentication", () => {
  it("accepts a correctly formatted bearer token", () => {
    expect(isOmaAuthorized(request(validBody), token)).toBe(true);
  });
  it("rejects missing, incorrect, malformed, and unconfigured tokens", () => {
    expect(isOmaAuthorized(new Request("https://example.workers.dev"), token)).toBe(false);
    expect(isOmaAuthorized(new Request("https://example.workers.dev", {
      headers: { Authorization: "Bearer wrong-token-value-that-is-long-enough" },
    }), token)).toBe(false);
    expect(isOmaAuthorized(new Request("https://example.workers.dev", {
      headers: { Authorization: "Bearer " + token + " extra" },
    }), token)).toBe(false);
    expect(isOmaAuthorized(new Request("https://example.workers.dev"), undefined)).toBe(false);
  });
});

describe("OMA endpoint", () => {
  it("fails closed until its secret is configured", async () => {
    const response = await handleOmaChatRequest(request(validBody), { AI: { run: vi.fn() } } as never);
    expect(response.status).toBe(503);
  });

  it("rejects unauthorized requests before model invocation", async () => {
    const run = vi.fn();
    const response = await handleOmaChatRequest(request(validBody, false), { JARVIS_OMA_TOKEN: token, AI: { run } } as never);
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves the existing text-only OMA response contract", async () => {
    const run = vi.fn().mockResolvedValue({
      response: "Reviewed safely.",
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
    const response = await handleOmaChatRequest(request(validBody), { JARVIS_OMA_TOKEN: token, AI: { run } } as never);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      id: string; model: string; content: Array<{ type: string; text?: string }>;
      stop_reason: string; usage: { input_tokens: number; output_tokens: number };
    };
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(data.model).toBe("@cf/qwen/qwen3.8-27b");
    expect(data.content).toEqual([{ type: "text", text: "Reviewed safely." }]);
    expect(data.stop_reason).toBe("end_turn");
    expect(data.usage).toEqual({ input_tokens: 12, output_tokens: 4 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns tool_use blocks and forwards only the supplied tool schemas to Workers AI", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: "call_wonk_1",
            type: "function",
            function: { name: "wonk_search", arguments: JSON.stringify({ query: "Agent adapter" }) },
          }],
        },
      }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });
    const response = await handleOmaChatRequest(request({ ...validBody, tools: [wonkTool] }), {
      JARVIS_OMA_TOKEN: token, AI: { run },
    } as never);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason: string;
    };
    expect(data.content).toEqual([{
      type: "tool_use", id: "call_wonk_1", name: "wonk_search", input: { query: "Agent adapter" },
    }]);
    expect(data.stop_reason).toBe("tool_use");
    const modelInput = run.mock.calls[0][1] as { tools: Array<{ name: string; parameters: unknown }>; parallel_tool_calls: boolean };
    expect(modelInput.tools).toHaveLength(1);
    expect(modelInput.tools[0].name).toBe("wonk_search");
    expect(modelInput.parallel_tool_calls).toBe(false);
  });


  it("normalizes the native Workers AI tool_calls response shape", async () => {
    const run = vi.fn().mockResolvedValue({
      tool_calls: [{ name: "wonk_search", arguments: { query: "README" } }],
    });
    const response = await handleOmaChatRequest(request({ ...validBody, tools: [wonkTool] }), {
      JARVIS_OMA_TOKEN: token, AI: { run },
    } as never);
    expect(response.status).toBe(200);
    const data = await response.json() as {
      content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason: string;
    };
    expect(data.content).toHaveLength(1);
    expect(data.content[0]).toMatchObject({
      type: "tool_use", name: "wonk_search", input: { query: "README" },
    });
    expect(data.content[0].id).toMatch(/^call_[a-f0-9-]+$/i);
    expect(data.stop_reason).toBe("tool_use");
  });

  it("converts prior tool results back into model tool messages", async () => {
    const run = vi.fn().mockResolvedValue({ response: "The index found two references." });
    const body = {
      messages: [
        { role: "user", content: "Search the code." },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "wonk_search", input: { query: "adapter" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Found two references." }] },
      ],
      tools: [wonkTool],
    };
    const response = await handleOmaChatRequest(request(body), { JARVIS_OMA_TOKEN: token, AI: { run } } as never);
    expect(response.status).toBe(200);
    const modelInput = run.mock.calls[0][1] as { messages: Array<{ role: string; tool_call_id?: string; content: string | null }> };
    expect(modelInput.messages[modelInput.messages.length - 1]).toMatchObject({
      role: "tool", tool_call_id: "call_1", content: "Found two references.",
    });
  });

  it("rejects model tool calls that were not in the request allowlist", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { tool_calls: [{
        id: "call_unknown", type: "function",
        function: { name: "delete_files", arguments: "{}" },
      }] } }],
    });
    const response = await handleOmaChatRequest(request({ ...validBody, tools: [wonkTool] }), {
      JARVIS_OMA_TOKEN: token, AI: { run },
    } as never);
    expect(response.status).toBe(502);
  });

  it("returns estimated usage when provider usage is absent", async () => {
    const run = vi.fn().mockResolvedValue({ response: "Estimated usage." });
    const response = await handleOmaChatRequest(request(validBody), { JARVIS_OMA_TOKEN: token, AI: { run } } as never);
    expect(response.status).toBe(200);
    const data = await response.json() as { usage: { input_tokens: number; output_tokens: number } };
    expect(data.usage.input_tokens).toBeGreaterThan(0);
    expect(data.usage.output_tokens).toBeGreaterThan(0);
  });
});
