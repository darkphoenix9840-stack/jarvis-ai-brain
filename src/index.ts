
/**
 * JARVIS AI BRAIN
 * Cloudflare Workers AI backend
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/zai-org/glm-4.7-flash";

const SYSTEM_PROMPT =
  "You are JARVIS, a helpful and intelligent personal AI assistant. " +
  "Speak naturally and conversationally. Understand follow-up questions " +
  "using the supplied conversation history. Use friendly Hinglish when " +
  "the user uses Hinglish. Address the user respectfully. " +
  "Never claim to have performed a phone action unless the Android app confirms it. " +
  "Give accurate, clear and useful answers. Keep replies concise unless detail is needed.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;

  const item = value as {
    role?: unknown;
    content?: unknown;
  };

  return (
    (item.role === "user" || item.role === "assistant") &&
    typeof item.content === "string"
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Existing browser interface
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // Android app endpoint
    if (url.pathname === "/api/mobile-chat") {
      if (request.method !== "POST") {
        return json({ error: "Use POST request." }, 405);
      }

      return handleMobileChatRequest(request, env);
    }

    // Existing browser streaming endpoint
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      return handleBrowserChatRequest(request, env);
    }

    return json({ error: "Endpoint not found." }, 404);
  },
} satisfies ExportedHandler<Env>;


/**
 * Android app: normal JSON response
 */
async function handleMobileChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = await request.json() as {
      message?: unknown;
      history?: unknown;
    };

    if (
      typeof body.message !== "string" ||
      body.message.trim().length === 0 ||
      body.message.length > 2000
    ) {
      return json({ error: "Message is empty or too long." }, 400);
    }

    const history = Array.isArray(body.history)
      ? body.history
          .filter(isChatMessage)
          .slice(-10)
          .map(item => ({
            role: item.role,
            content: item.content.slice(0, 1500),
          }))
      : [];

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: body.message.trim() },
    ];

    const result = await env.AI.run<typeof MODEL_ID>(
      MODEL_ID,
      {
        messages,
        max_tokens: 512,
        stream: false,
      },
    ) as { response?: string };

    const reply = result.response?.trim();

    if (!reply) {
      return json({ error: "AI returned an empty response." }, 502);
    }

    return json({ reply });

  } catch (error) {
    console.error("Mobile chat error:", error);
    return json({
      error: "Could not process your message. Please try again.",
    }, 502);
  }
}


/**
 * Browser: preserve existing streaming chat
 */
async function handleBrowserChatRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = await request.json() as {
      messages?: unknown;
    };

    const history = Array.isArray(body.messages)
      ? body.messages
          .filter(isChatMessage)
          .slice(-20)
      : [];

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];

    const stream = await env.AI.run<typeof MODEL_ID>(
      MODEL_ID,
      {
        messages,
        max_tokens: 1024,
        stream: true,
      },
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (error) {
    console.error("Browser chat error:", error);

    return json({
      error: "Failed to process chat request.",
    }, 500);
  }
}
