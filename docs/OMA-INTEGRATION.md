# OMA five-agent integration

This feature adds a separate authenticated model-adapter endpoint to the existing JARVIS AI Brain Worker. It does not replace or change `/api/mobile-chat`, `/api/chat`, `/api/memory`, the D1 schema, or the existing memory-context fix.

## Endpoint

`POST /api/oma/chat`

Headers: `Authorization: Bearer <JARVIS_OMA_TOKEN>` and `Content-Type: application/json`.

### Text-only request

```json
{
  "messages": [
    { "role": "system", "content": "You are the reviewer agent." },
    { "role": "user", "content": "Review this proposed change." }
  ],
  "maxTokens": 700
}
```

### Tool-enabled request

The local OMA client may provide a small allowlist of tools. The Worker maps the OMA `input_schema` into Cloudflare Workers AI's native `{ name, description, parameters }` tool format and returns any model-selected calls to the local client. It normalizes both Workers AI's native `{ name, arguments }` call records and OpenAI-compatible `{ function: { name, arguments } }` records.

```json
{
  "messages": [
    { "role": "system", "content": "Use code-index tools only when useful." },
    { "role": "user", "content": "Find where the worker adapter is implemented." }
  ],
  "maxTokens": 700,
  "tools": [
    {
      "name": "wonk_search",
      "description": "Search the local code index. Read-only.",
      "input_schema": {
        "type": "object",
        "properties": { "query": { "type": "string", "maxLength": 200 } },
        "required": ["query"],
        "additionalProperties": false
      }
    }
  ],
  "tool_choice": "auto"
}
```

A model tool call is returned in the OMA-compatible content format:

```json
{
  "id": "generated-request-uuid",
  "model": "@cf/qwen/qwen3.8-27b",
  "content": [
    {
      "type": "tool_use",
      "id": "call_wonk_1",
      "name": "wonk_search",
      "input": { "query": "worker adapter" }
    }
  ],
  "stop_reason": "tool_use",
  "usage": { "input_tokens": 30, "output_tokens": 12 }
}
```

The local client executes the selected tool and sends its result back as a user `tool_result` content block, paired with the assistant's prior `tool_use` block. The Worker maps this conversation back into the model's tool-call message format. Normal text responses retain the existing `content: [{ "type": "text", "text": "..." }]` shape and use `stop_reason: "end_turn"`.

## Limits and validation

- Bearer token must be configured and at least 24 characters.
- At most 20 messages, 10,000 characters per message, 16,000 total message characters, 20,000 request bytes, and 64–1,400 completion tokens.
- At most 8 uniquely named tools, each with an object JSON schema no larger than 8 KiB; at most 4 model tool calls per response.
- Tool names and call IDs are restricted to safe identifier characters. Tool calls must match a name in the request allowlist and contain a JSON object as arguments.
- `tool_choice` accepts only `auto` or `none`; no forced tool invocation.
- Response body is bounded to 16,000 bytes. Token counts are estimated when Workers AI does not return usage.

## Configuration

Create a Cloudflare Worker secret named `JARVIS_OMA_TOKEN` with a random value of at least 24 characters. Keep the same value in the local OMA client's ignored `.dev.vars` file or environment variable. Never commit or paste the value into GitHub, chat, logs, or screenshots.

The endpoint returns `503` until the secret is configured and `401` for an invalid bearer token. Existing mobile chat and memory API behavior is independent.

## Safety and boundaries

- The Worker is a model adapter only. It returns tool requests; it **never executes** the supplied tools.
- Only the local OMA client can execute a tool, subject to its own role allowlist, permission checks, path restrictions, and user approval policy.
- Start with read-only Wonk code-index tools. Do not expose shell, arbitrary file writes, GitHub writes, patch application, secrets, or deployment as model tools.
- Does not read or write D1 memory.
- Existing mobile chat, browser chat, memory endpoints, and D1 data are not modified.
- This branch prepares source code only; it does not deploy the Worker, create Cloudflare secrets, or change the default branch.
- The local OMA worker adapter must be updated separately to send tool schemas and relay `tool_use` / `tool_result` blocks. Until that client-side change is made, existing text-only OMA calls continue to work and no local tools are invoked.
