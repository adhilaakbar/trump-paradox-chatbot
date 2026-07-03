// Cloudflare Worker: paper chatbot proxy with source citations.
// Holds ANTHROPIC_API_KEY as a secret; the paper is sent as a *citable document*
// so each answer comes back with exact quoted sources. Returns structured JSON.
import { PAPER } from "./paper.js";

const MODEL = "claude-opus-4-8";   // switch to "claude-sonnet-5" for lower cost
const MAX_TOKENS = 1024;
const TITLE = "Trump Paradox II";

const SYSTEM = `You are the Q&A assistant for a single academic paper, attached to you as a document titled "${TITLE}".

Rules:
- Answer ONLY from the attached paper. If something is not in it, say so plainly.
- Never invent or alter numbers, coefficients, p-values, or table values; quote them exactly.
- Ground every claim in the document text (citations are captured automatically).
- Be concise and neutral. The paper is observational — describe associations, not causal effects.
- End your reply with one final line starting exactly with "FOLLOWUPS:" followed by three short next-questions a reader might ask, separated by " | " (each under 12 words). Put nothing after that line.`;

// Precompute heading offsets so we can label each citation with its section.
const HEADINGS = (() => {
  const out = []; const re = /^#{1,3}[ \t]+(.*)$/gm; let m;
  while ((m = re.exec(PAPER)) !== null) out.push({ idx: m.index, title: m[1].trim() });
  return out;
})();
function sectionFor(charIdx) {
  let label = null;
  for (const h of HEADINGS) { if (h.idx <= charIdx) label = h.title; else break; }
  return label;
}

function cors(o) {
  return { "Access-Control-Allow-Origin": o || "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
           "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
}
function json(obj, status, o) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors(o), "content-type": "application/json" } });
}

export default {
  async fetch(request, env) {
    const o = request.headers.get("Origin");
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(o) });
    if (request.method !== "POST") return json({ error: "Use POST." }, 405, o);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server missing ANTHROPIC_API_KEY secret." }, 500, o);

    let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400, o); }
    const turns = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      .slice(-16);
    if (!turns.length || turns[turns.length - 1].role !== "user")
      return json({ error: "Send a user message." }, 400, o);

    // Attach the paper as a citable document on the first user turn (cached).
    const messages = turns.map((m, i) =>
      (i === 0 && m.role === "user")
        ? { role: "user", content: [
            { type: "document",
              source: { type: "text", media_type: "text/plain", data: PAPER },
              title: TITLE, citations: { enabled: true },
              cache_control: { type: "ephemeral" } },
            { type: "text", text: m.content } ] }
        : m);

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages }),
    });
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => "");
      return json({ error: "Claude API error", status: upstream.status, detail: t.slice(0, 600) }, 502, o);
    }
    const data = await upstream.json();

    let text = ""; const cites = []; const seen = new Set();
    for (const block of (data.content || [])) {
      if (block.type !== "text") continue;
      text += block.text;
      for (const c of (block.citations || [])) {
        const start = c.start_char_index ?? 0;
        const section = sectionFor(start) || TITLE;
        const quote = (c.cited_text || "").trim().replace(/\s+/g, " ");
        const key = section + "|" + quote.slice(0, 60);
        if (quote && !seen.has(key)) { seen.add(key); cites.push({ section, quote }); }
      }
    }
    let followups = [];
    const fi = text.lastIndexOf("FOLLOWUPS:");
    if (fi !== -1) {
      followups = text.slice(fi + 10).split("|").map((s) => s.trim()).filter(Boolean).slice(0, 3);
      text = text.slice(0, fi).trim();
    }
    return json({ answer: text, citations: cites.slice(0, 6), followups, model: data.model, usage: data.usage }, 200, o);
  },
};
