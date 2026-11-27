import { describe, expect, it } from "vitest";
import { isOmaAuthorized, validateOmaPayload } from "../src/oma";

const token = "test-token-that-is-at-least-24-characters";

describe("OMA request validation", () => {
  it("accepts bounded role-preserving messages", () => {
    expect(validateOmaPayload({ messages: [
      { role: "system", content: "Reviewer role." },
      { role: "user", content: "Review this change." },
    ] })).toMatchObject({ maxTokens: 700 });
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
  it("accepts the configured bearer token", () => {
    const request = new Request("https://example.workers.dev/api/oma/chat", { headers: { Authorization: "Bearer " + token } });
    expect(isOmaAuthorized(request, token)).toBe(true);
  });
  it("rejects missing, incorrect, and unconfigured tokens", () => {
    expect(isOmaAuthorized(new Request("https://example.workers.dev"), token)).toBe(false);
    expect(isOmaAuthorized(new Request("https://example.workers.dev", {
      headers: { Authorization: "Bearer wrong-token-value-that-is-long-enough" },
    }), token)).toBe(false);
    expect(isOmaAuthorized(new Request("https://example.workers.dev"), undefined)).toBe(false);
  });
});
