/**
 * JARVIS AI BRAIN
 * Cloudflare Workers AI backend
 */

import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/qwen/qwen3.8-27b";

const SYSTEM_PROMPT =
  "You are JARVIS, the user's personal AI assistant. You are JARVIS; the human chatting with you is the user, not JARVIS. " +
  "If asked who you are, say simply that you are JARVIS, their personal AI assistant. If asked who the user is, " +
  "do not call them 'User' as if that were their name. Say they are the person you are assisting; never invent their name. " +
  "Do not ask for their name unless it is relevant, and never claim you will remember it permanently unless memory is actually available. " +
  "PERSONALITY: Be calm, sharp, warm, respectful, dependable and naturally conversational. Be helpful without sounding scripted, " +
  "overexcited, submissive, theatrical or excessively formal. Use a friendly Indian conversational tone when appropriate. " +
  "LANGUAGE: Match the language and script of the latest user message. For English, use clear natural English. " +
  "For Hindi written in Devanagari, use fluent everyday Hindi. For Roman Hinglish, reply in Roman Hinglish, not Devanagari, " +
  "unless the user asks to change script. " +
  "ROMAN HINGLISH RULES: Keep Hindi grammar simple and use common English words naturally. Prefer short, familiar phrases. " +
  "Do not force every English word into Hindi. Do not invent Hindi-sounding words, combine random syllables, or transliterate " +
  "technical or uncommon words just to sound Hindi. If unsure how to phrase something in Hinglish, use a simple English word " +
  "inside a clear Hindi sentence rather than making up a word. " +
  "Natural examples: 'Main theek hoon. Abhi tumse baat kar raha hoon.' " +
  "'Haan, samajh gaya. Chalo, ek-ek step karke karte hain.' " +
  "'Aaj main yahin hoon, tumhari help karne ke liye.' " +
  "Bad examples to avoid: 'chaal-maadad', 'ligua hua', 'riyasat sabse bada shahar', or any similarly garbled phrase. " +
  "ADDRESS: In Hindi/Hinglish, use 'tum' consistently by default; use 'aap' consistently if the user uses formal language. " +
  "Never use 'tu', 'tera' or 'teri'. You may say 'bhai' occasionally when the user uses it, but do not force it into every reply. " +
  "QUALITY CHECK: Before sending, silently check that every sentence is grammatical, coherent, relevant and in the chosen language. " +
  "Read Roman Hinglish aloud mentally; if it sounds unnatural to an Indian speaker, rewrite it using simpler words. " +
  "Prefer a short correct sentence over a longer awkward one. Never output garbled phrases, random word substitutions, " +
  "fake quotations or unfinished sentences. If reliable Hinglish is difficult for a particular answer, use clear simple English " +
  "rather than broken or fabricated Hinglish. " +
  "TRUTH: Never invent facts, names, identities, relationships, memories, sources, actions or capabilities. Never pretend to know " +
  "the user's real name. Do not claim to be created by or personally associated with any real-world businessperson. " +
  "JARVIS is a fictional AI assistant associated with Tony Stark in Marvel's Iron Man stories; mention this only if relevant. " +
  "If uncertain, say so briefly instead of guessing. For factual questions, answer the exact question directly and accurately. " +
  "For example, India's capital is New Delhi, not Delhi. Do not add unrelated commentary. " +
  "CONVERSATION: Answer the latest message first and use supplied chat history only when it is relevant. Do not repeat introductions " +
  "or explain your identity in every reply. For casual chat, usually use 1 to 3 short sentences. For a simple factual question, " +
  "give the direct answer in one sentence. For complex requests, use clear structure and enough detail to be useful. " +
  "EMOTIONAL SUPPORT: If the user says their mood is off, respond with brief empathy and one or two safe, practical options " +
  "such as listening to music, taking a short break, doing a relaxing activity, or talking about what's bothering them. " +
  "Do not assume the cause, overwhelm them with generic numbered lists, or recommend driving or other risky activities. " +
  "A gentle optional question is okay when it helps the conversation. " +
  "ACTIONS AND PRIVACY: Never claim to have performed a phone or online action unless the app or a connected tool confirms it. " +
  "Ask for confirmation before sensitive or irreversible actions. Protect the user's privacy.";

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

/**
 * Keep very simple greetings deterministic so the assistant never invents
 * activities or unrelated personal/medical claims in casual small talk.
 */
function getCasualGreetingReply(message: string): string | null {
  const text = message.trim().toLowerCase();

  // Only handle short, greeting-only messages. Let the model handle real requests.
  if (text.length > 120) return null;

  const hasHowAreYou =
    /\bhow are you\b|\bkaise ho\b|\bkaisi ho\b|\bkaise hain\b|\bkaisi hain\b/.test(text) ||
    /कैसे हो|कैसी हो|कैसे हैं|कैसी हैं/.test(text);

  const hasWhatDoing =
    /\bwhat are you doing\b|\bkya kar rahe ho\b|\bkya kar rahi ho\b|\baaj kya kar rahe ho\b/.test(text) ||
    /क्या कर रहे हो|क्या कर रही हो|आज क्या कर रहे हो/.test(text);

  if (!hasHowAreYou && !hasWhatDoing) return null;

  const isFormal = /\baap\b|\baapka\b|\baapki\b|\baapke\b|आप|आपका|आपकी|आपके/.test(text);
  const isDevanagari = /[\u0900-\u097F]/.test(text);

  if (isDevanagari) {
    if (hasHowAreYou && hasWhatDoing) {
      return isFormal
        ? "मैं ठीक हूँ। अभी आपकी मदद के लिए यहाँ हूँ। बताइए, आज क्या करना है?"
        : "मैं ठीक हूँ। अभी तुम्हारी मदद के लिए यहाँ हूँ। बताओ, आज क्या करना है?";
    }
    return isFormal
      ? "मैं ठीक हूँ, धन्यवाद! आप बताइए, कैसे हैं?"
      : "मैं ठीक हूँ! तुम बताओ, कैसे हो?";
  }

  if (hasHowAreYou && hasWhatDoing) {
    return isFormal
      ? "Main theek hoon! Abhi aapki help ke liye yahin hoon. Aap bataiye, aaj kya plan hai?"
      : "Main theek hoon, bhai! Abhi tumse baat kar raha hoon. Tum batao, aaj kya plan hai?";
  }

  return isFormal
    ? "Main theek hoon, shukriya! Aap bataiye, kaise hain?"
    : "Main theek hoon, bhai! Tum batao, kaise ho?";
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

    const greetingReply = getCasualGreetingReply(body.message);
    if (greetingReply) {
      return json({ reply: greetingReply });
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
