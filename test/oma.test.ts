import { describe, expect, it, vi } from "vitest";
import { handleOmaChatRequest, isOmaAuthorized, validateOmaPayload } from "../src/oma";

const token = "test-token-that-is-at-least-24-characters";
const validBody = {
  messages: [
    { role: "system", content: "Reviewer role." },
    { role: "user", content: "Review this change." },
  ],
};

describe("OMA request validation", () => {
  it("accepts bounded role-preserving messages", () => {
    expect(validateOmaPayload(validBody)).toMatchObject({ maxTokens: 700 });
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
});

describe("OMA bearer authentication", () => {
  it("accepts a correctly formatted bearer token", () => {
    const request = new Request("https://example.workers.dev/api/oma/chat", {
      headers: { Authorization: "Bearer " + token },
    });
    expect(isOmaAuthorized(request, token)).toBe(true);
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
    const request = new Request("https://example.workers.dev/api/oma/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const response = await handleOmaChatRequest(request, { AI: { run: vi.fn() } } as never);
    expect(response.status).toBe(503);
  });

  it("rejects unauthorized requests before model invocation", async () => {
    const run = vi.fn();
    const request = new Request("https://example.workers.dev/api/oma/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const response = await handleOmaChatRequest(request, { JARVIS_OMA_TOKEN: token, AI: { run } } as never);
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns bounded model output for an authorized request", async () => {
    const run = vi.fn().mockResolvedValue({ response: "Reviewed safely." });
    const request = new Request("https://example.workers.dev/api/oma/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(validBody),
    });
    const response = await handleOmaChatRequest(request, { JARVIS_OMA_TOKEN: token, AI: { run } } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      content: "Reviewed safely.",
      usage: { estimated: true },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
