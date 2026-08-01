# Wholesale Sales Agent (MVP)

A text-based wholesale sales agent. It talks to buyers, looks up products / offers /
stock, reads the customer's emotion, estimates satisfaction, finds similar offers,
manages a cart, and places orders — built on **LangGraph + Claude**, streamed to
clients over **SSE backed by Redis**, with **Postgres** for data. Everything runs in
Docker containers via Docker Compose. No local dependencies beyond Docker.

Phone-call → text transcription is out of scope (handled elsewhere). This service
receives text and produces the agent's text replies.

## Architecture

```
client ──POST /start, /continue──▶ FastAPI (api container)
      ◀──SSE /events──────────────┘        │
                                            │ runs LangGraph react agent (Claude)
Redis (event stream)  ◀── tokens/tool events / analysis
Postgres  ◀── products, offers, stock, carts, orders, messages, conversations
```

- **api** — FastAPI. `/start` and `/continue` schedule an agent turn on a worker
  thread; the turn streams tokens + tool calls + emotion/satisfaction analysis into
  a Redis list; `/events` is an SSE endpoint that long-polls that list.
- **db** — Postgres 16, tables auto-created and seeded on first boot.
- **redis** — event bus between the worker turn and the SSE stream.

## Tools the agent has

`get_products`, `get_product_info`, `get_offer`, `get_similar_offers`, `check_stock`,
`update_cart`, `view_cart`, `analyze_cost`, `place_order`, `ask_user_question`.

## Run it

The stack **builds and boots without an API key**. Agent turns need the key; add it
whenever you're ready.

```bash
# 1. (optional) set your key
export ANTHROPIC_API_KEY=sk-ant-...     # or copy .env.example -> .env and fill it in

# 2. build + start everything
docker compose up --build
```

API is on http://localhost:8000. Check it's alive:

```bash
curl localhost:8000/health
curl localhost:8000/products
curl localhost:8000/customers
```

## Try a conversation

Open the SSE stream in one terminal, drive the agent from another.

```bash
# start a conversation (optionally with a first message + a known customer)
curl -s -X POST localhost:8000/conversations/start \
  -H 'content-type: application/json' \
  -d '{"customer_id": 1, "message": "Hi, I run a corner shop and need cola and water in bulk. What can you do on price?"}'
# -> {"conversation_id": 1, "status": "open"}

# stream the agent's response (tokens, tool calls, final message, emotion/satisfaction)
curl -N localhost:8000/conversations/1/events

# send more turns
curl -s -X POST localhost:8000/conversations/1/continue \
  -H 'content-type: application/json' \
  -d '{"message": "Give me 60 cases of cola and 40 of water. Place the order."}'

# inspect stored state (messages, cart, emotion, satisfaction)
curl -s localhost:8000/conversations/1 | jq
```

### SSE event types

Each `data:` line is JSON with a `type`:

- `token` — incremental assistant text (`{"type":"token","text":"..."}`)
- `tool_call` — agent invoked a tool (`name`, `args`)
- `tool_result` — tool output (`name`, `content`)
- `message` — final assistant message for the turn
- `analysis` — `emotion`, `satisfaction_score` (0–1), `satisfaction_label`
- `done` — turn finished
- `error` — turn failed (`message`) — e.g. missing/invalid API key
- `heartbeat` — idle keep-alive

## Config

Environment variables (see `.env.example`):

| var | default | purpose |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | _(unset)_ | Claude key; required only for agent turns |
| `CLAUDE_MODEL` | `claude-sonnet-5` | model id (`claude-haiku-4-5` for cheapest/fastest) |
| `MAX_TOKENS` | `4096` | max output tokens per turn |
| `DATABASE_URL` | compose-set | Postgres DSN |
| `REDIS_URL` | compose-set | Redis URL |

## Notes

- Data resets? `docker compose down -v` drops the Postgres volume; next boot reseeds.
- The agent, tools, and system prompt live in `app/sales_agent/`.
