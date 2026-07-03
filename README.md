# Trump Paradox II — Paper Chatbot

A small web chatbot that answers questions about the paper, grounded only in the
manuscript text. Architecture:

```
  Browser (GitHub Pages, static index.html)
        │  POST { messages }
        ▼
  Cloudflare Worker  ──  holds ANTHROPIC_API_KEY as a secret
        │  injects the full paper as cached context
        ▼
  Claude API (streaming)  →  streamed back to the browser
```

The API key lives only in the Worker (a serverless function). The public site
never sees it. The whole paper (~13k tokens) is sent as a **cached** system
prompt, so every question after the first reads it at ~0.1× cost.

Files:
- `index.html` — the static chat page (deploy to GitHub Pages).
- `worker/worker.js` — the Cloudflare Worker (the API proxy).
- `worker/paper.js` — the manuscript text, embedded (regenerate with the snippet below).
- `paper.md` — the manuscript extracted to Markdown (source for `paper.js`).

---

## Prerequisites

1. An **Anthropic API key** — get one at <https://console.anthropic.com> → *API Keys*
   (they start with `sk-ant-api03-…`). Add a little credit under *Billing*.
   *Note: this is NOT the Census key used for the trade data — that's a different service.*
2. A free **Cloudflare** account — <https://dash.cloudflare.com/sign-up>.
3. A **GitHub** account (for hosting the page).
4. Node.js installed (for the `wrangler` CLI). Check with `node -v`.

---

## Step 1 — Deploy the Worker (holds your key)

```bash
cd chatbot/worker
npx wrangler login                       # opens a browser to authorize Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY   # paste your sk-ant-... key when prompted
npx wrangler deploy
```

`deploy` prints a URL like:

```
https://trump-paradox-chatbot.<your-subdomain>.workers.dev
```

Copy that URL.

**Test it** (should stream an answer):

```bash
curl -N https://trump-paradox-chatbot.<your-subdomain>.workers.dev \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the main finding?"}]}'
```

## Step 2 — Point the page at the Worker

Edit `chatbot/index.html`, near the top of the `<script>`:

```js
const WORKER_URL = "https://trump-paradox-chatbot.<your-subdomain>.workers.dev";
```

## Step 3 — Publish the page on GitHub Pages

1. Create a GitHub repo and push this project (or just the `chatbot/` folder).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → pick your branch
   and the folder that contains `index.html` (e.g. `/chatbot` or root) → **Save**.
3. After ~1 minute your site is live at
   `https://<user>.github.io/<repo>/` (or `.../chatbot/` if you used a subfolder).

That's it — open the page and ask questions.

---

## Updating the paper text

If the manuscript changes, regenerate `worker/paper.js` from a fresh Markdown
export and redeploy the Worker:

```bash
python3 - << 'PY'
import json
paper = open("paper.md").read()
open("worker/paper.js","w").write(
    "// Auto-generated from ../paper.md\nexport const PAPER = " + json.dumps(paper) + ";\n")
PY
cd worker && npx wrangler deploy
```

## Cost & model notes

- Default model is `claude-opus-4-8` (most capable). The paper context is cached,
  so a typical question costs a small fraction of a cent in input + a short answer.
- To cut cost further, change `MODEL` in `worker/worker.js` to `claude-sonnet-5`
  and redeploy.
- `MAX_TOKENS` (1500) caps answer length; raise it in `worker.js` if you want
  longer answers.

## Guardrails already built in

- The system prompt restricts answers to the paper and forbids inventing numbers.
- Requests are limited to the last 20 turns; each message is length-capped.
- CORS is open (`*`) so the GitHub Pages origin can call the Worker. To lock it to
  your domain, replace `origin || "*"` in `worker.js` with your Pages URL.
