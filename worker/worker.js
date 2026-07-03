// Cloudflare Worker: proxies the paper chatbot to the Claude API.
// The ANTHROPIC_API_KEY is stored as a Worker secret and never reaches the browser.
import { PAPER } from "./paper.js";

const MODEL = "claude-opus-4-8"; // most capable; switch to "claude-sonnet-5" for lower cost
const MAX_TOKENS = 1500;

const SYSTEM = `You are the Q&A assistant for a single academic paper, "Trump Paradox II: Immigration, Trade, and White Voting and Attitudes, 2012-2024."

Answer ONLY from the paper text provided below. Rules:
- If the answer is not in the paper, say so plainly ("The paper doesn't address that") rather than guessing.
- Never invent or alter numbers, coefficients, p-values, or table values. Quote them exactly as they appear.
- When useful, point to the specific table, figure, or section (e.g., "Table 2", "the over-time tests").
- Be concise and neutral. You are describing what the paper says, not endorsing it.
- The paper is observational; describe findings as associations, not causal effects.

=== PAPER TEXT START ===
${PAPER}
=== PAPER TEXT END ===`;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function jsonResponse(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS")
      return new Response(null, { headers: corsHeaders(origin) });
    if (request.method !== "POST")
      return jsonResponse({ error: "Use POST." }, 405, origin);
    if (!env.ANTHROPIC_API_KEY)
      return jsonResponse({ error: "Server missing ANTHROPIC_API_KEY secret." }, 500, origin);

    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: "Invalid JSON body." }, 400, origin); }

    // Accept only well-formed user/assistant turns; cap history length.
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") &&
                     typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      .slice(-20);
    if (!messages.length || messages[messages.length - 1].role !== "user")
      return jsonResponse({ error: "Send a non-empty user message." }, 400, origin);

    const anthropicRequest = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    };

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicRequest),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return jsonResponse(
        { error: "Claude API error", status: upstream.status, detail: detail.slice(0, 800) },
        502, origin
      );
    }

    // Pipe the SSE stream straight back to the browser.
    return new Response(upstream.body, {
      headers: {
        ...corsHeaders(origin),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  },
};
