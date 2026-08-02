# Voice Sales Agent

Talk to a wholesale sales agent by voice, continuously. Speech is transcribed by
**Inworld STT**, answered by our **Claude-powered wholesale agent** (recommends
products, checks stock, suggests bulk discounts, adapts to your offer
preferences), and spoken back with **Inworld TTS** — then it listens again.

Two pieces:

| Piece | Stack | Port | Role |
|---|---|---|---|
| **Sales agent** | FastAPI + LangGraph + Claude, Postgres, Redis (`app/`, `docker-compose.yml`) | 8000 | The brain: tools, cart, sentiment, preferences |
| **Voice gateway** | Node + `ws` (`src/`, `public/`) | 8080 | Mic ⇄ Inworld STT/TTS, drives the agent |

```
browser mic ──▶ /voice/media (WS) ──▶ Inworld STT ──▶ sales agent (:8000)
   ▲                                                        │
   └────── plays TTS ◀── Inworld TTS ◀── agent reply text ◀─┘   (loops)
```

## Run it

**1. Start the sales agent** (needs your Claude key):

```bash
cp .env.example .env        # then fill in ANTHROPIC_API_KEY and INWORLD_API_KEY
docker compose up -d --build
curl localhost:8000/health  # {"status":"ok",...,"has_key":true}
```

**2. Start the voice gateway:**

```bash
npm install                 # installs `ws`
set -a; source .env; set +a
npm start                   # → http://localhost:8080
```

> On a corp network where `npm install` can't reach the internal registry, use
> the public one: `npm install ws --registry=https://registry.npmjs.org`.

**3. Open the demo:** visit <http://localhost:8080/voice>, click **Start talking**,
and speak. Mic access works on `localhost` without HTTPS. The page shows the live
transcript, the agent's reply, and speaks it aloud, then auto-listens for your
next turn.

## Endpoints (voice gateway)

- `GET /voice` — browser mic demo (continuous conversation).
- `GET /health` — STT/TTS models and agent URL.
- `POST /api/tts` — `{ "text": "..." }` → `audio/wav` (Inworld TTS).
- `WS /voice/media` — browser audio in (16 kHz LINEAR16 base64 frames); emits
  `partial_transcript` / `user_transcript` / `agent_text` / `agent_audio` / `status`.
- `WS /twilio/media` — optional Twilio Media Stream → Inworld STT (enabled only
  when `TWILIO_AUTH_TOKEN` is set). Phone audio (8 kHz mu-law) is upsampled to
  16 kHz LINEAR16.

## Config

See `.env.example`. Required: `INWORLD_API_KEY` (gateway) and `ANTHROPIC_API_KEY`
(agent). `WHOLESALE_AGENT_URL` defaults to `http://127.0.0.1:8000`.

## Notes

- The sales agent (tools, cart, sentiment, preferences, order flow) lives in
  `app/`; it's the same service you can drive directly over HTTP/SSE.
- One voice session = one agent conversation, so the agent keeps cart and learned
  preferences across turns.
- While the agent is speaking, the mic is muted to avoid self-capture; it resumes
  when playback finishes.
