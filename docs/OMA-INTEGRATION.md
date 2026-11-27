# OMA five-agent integration

This feature adds a separate authenticated model-adapter endpoint to the existing JARVIS AI Brain Worker. It does not replace or change `/api/mobile-chat`, `/api/chat`, `/api/memory`, the D1 schema, or the existing memory-context fix.

## Endpoint

`POST /api/oma/chat`

Headers: `Authorization: Bearer <JARVIS_OMA_TOKEN>` and `Content-Type: application/json`.

Request:
```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are the reviewer agent."
    },
    {
      "role": "user",
      "content": "Review this proposed change."
    }
  ],
  "maxTokens": 700
}
```

Response contains `content` and `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, `estimated`). Token counts are estimates when Workers AI does not return usage.

## Configuration

Create a Cloudflare Worker secret named `JARVIS_OMA_TOKEN` with a random value of at least 24 characters. Keep the same value in the local OMA client's ignored `.dev.vars` file or environment variable. Never commit or paste the value into GitHub, chat, logs, or screenshots.

The endpoint returns `503` until the secret is configured and `401` for an invalid bearer token. Existing mobile chat and memory API behavior is independent.

## Safety and boundaries

- Text-only JSON messages; roles limited to `system`, `user`, and `assistant`.
- At most 20 messages, 10,000 characters per message, 16,000 total characters, 20,000 request bytes, and 64–1,400 completion tokens.
- Uses the existing Workers AI binding and configured model.
- Does not read or write D1 memory and does not expose filesystem, shell, GitHub-write, patch-apply, or deployment tools.
- Existing endpoints and D1 data are not modified.
- This PR prepares source code only; it does not deploy the Worker or create Cloudflare secrets.
