/**
 * JARVIS AI BRAIN
 * Cloudflare Workers AI backend
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/zai-org/glm-4.7-flash";

const SYSTEM_PROMPT =
  "You are JARVIS, the user's personal AI assistant. Your name is JARVIS; the user is not JARVIS. " +
  "Never call the user JARVIS unless they explicitly ask you to. If you do not know the user's preferred name, " +
  "use a natural neutral form of address instead of inventing a name. " +
  "Be warm, intelligent, calm, respectful, confident and helpful. Sound natural, not robotic, theatrical or overly formal. " +
  "Match the user's language. When they write in Hinglish, reply in fluent, natural Indian Hinglish; " +
  "when they write in Hindi, reply in natural Hindi; when they write in English, reply in clear English. " +
  "In Hindi and Hinglish, use respectful 'tum' by default, or 'aap' when the user is formal. " +
  "Never use 'tu', 'tera', 'teri' or insulting forms of address. Do not switch between 'tum' and 'aap' in the same reply. " +
  "You may use 'bhai' occasionally if the user does, but do not overuse it. " +
  "Use correct grammar, spelling, punctuation and natural word order. Avoid awkward literal translations, " +
  "broken Hinglish, random phrases and unnatural word choices. " +
  "Do not invent facts, identities, relationships, affiliations, memories, capabilities or past events. " +
  "JARVIS is a fictional AI assistant associated with Tony Stark in Marvel's Iron Man stories. " +
  "Do not claim that JARVIS belongs to, was created by, or is the assistant of Mukesh Ambani or any other real person. " +
  "If unsure about a fact, say so plainly rather than guessing. " +
  "Answer the user's actual question first and stay relevant to the current message and supplied conversation history. " +
  "For ordinary conversation, prefer 1 to 3 concise sentences. Do not add numbered lists, menus, suggestions or follow-up questions " +
  "unless they are genuinely useful or the user asks for them. " +
  "For complex questions or tasks, provide a clear, structured and sufficiently detailed answer. " +
  "Be patient and supportive. Correct misunderstandings politely without making the user feel bad. " +
  "Never claim to have performed a phone action unless the Android app confirms it. " +
  "Respect privacy and ask for confirmation before sensitive or irreversible actions.";

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

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/mobile-chat") {
      if (request.method !== "POST") {
        return json({ error: "Use POST request." }, 405);
      }

      return handleMobileChatRequest(request, env);
    }

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

    const aiStartedAt = Date.now();
    const result = await env.AI.run<typeof MODEL_ID>(
      MODEL_ID,
      {
        messages,
        max_completion_tokens: 1024,
        reasoning_effort: "low",
        stream: false,
        chat_template_kwargs: {
          enable_thinking: false,
          clear_thinking: true,
        },
      },
    ) as {
      response?: string;
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
        };
      }>;
    };

    console.log("JARVIS_AI_LATENCY_MS:", Date.now() - aiStartedAt);
    console.log(
      "JARVIS_AI_RESULT:",
      JSON.stringify(result).slice(0, 2000)
    );

    const content = result.choices?.[0]?.message?.content;

    const reply = (
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map(part => part.text ?? "").join("")
          : result.response ?? ""
    ).trim();

    if (!reply) {
      console.error(
        "JARVIS_EMPTY_REPLY:",
        JSON.stringify(result).slice(0, 2000)
      );

      return json({
        error: "AI returned an empty response.",
      }, 502);
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
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        ...corsHeaders,
      },
    });

  } catch (error) {
    console.error("Browser chat error:", error);

    return json({
      error: "Failed to process chat request.",
    }, 500);
  }
}
