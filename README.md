# Conversational ad injection service

This service does one job: it receives an inbound Twilio phone-call audio stream,
converts Twilio's 8 kHz G.711 mu-law frames to the 16 kHz LINEAR16 format required
by Inworld streaming STT, and emits transcript events from
`inworld/inworld-stt-1`.

It also exposes an ad-selection layer backed by locally ingested Bright Data
products, a browser voice demo, direct Inworld LLM/TTS calls, Tenstorrent semantic
ad selection, and a Twilio
speech-driven call flow. It does not place orders.

## Provider flow

```text
Caller
  → Twilio phone number
  → POST /twilio/voice
  → WSS /twilio/media (8 kHz mu-law)
  → format conversion (16 kHz LINEAR16)
  → Inworld streaming STT
  → JSON transcript log and optional transcript webhook
```

## Required credentials

Create `.env` from `.env.example` and provide:

- `INWORLD_API_KEY`: the Base64 credential from Inworld Settings → API Keys.
- `TWILIO_AUTH_TOKEN`: the Twilio Auth Token used to validate webhook signatures.
- `PUBLIC_BASE_URL`: the public HTTPS origin that routes to this service.

The service intentionally refuses to start when any required value is missing.
Do not commit `.env`.

## Install and run

Node.js 20 or newer is required.

```bash
npm install
set -a
source .env
set +a
npm start
```

Expose the service with a public HTTPS/WSS URL. In the Twilio phone-number console,
set **A call comes in** to:

```text
POST https://YOUR_HOST/twilio/voice
```

Twilio will connect the call to `wss://YOUR_HOST/twilio/media` automatically.

## Transcript output

Every result is written as one JSON line:

```json
{
  "type": "transcription",
  "callSid": "CA...",
  "streamSid": "MZ...",
  "text": "I need wireless headphones",
  "isFinal": true,
  "wordTimestamps": [],
  "receivedAt": "2026-08-01T20:00:00.000Z"
}
```

To send those events to another service, set `TRANSCRIPT_WEBHOOK_URL`. If that
receiver requires a bearer token, also set `TRANSCRIPT_WEBHOOK_BEARER`.

## Health check

```text
GET /health
```

Returns the selected Inworld model without exposing credentials.

## Sponsored product selection

`POST /ads/select` matches shopping intent against the local product catalog,
applies budget, rejection, availability, and per-call frequency controls, and
returns fixed-template spoken copy with an explicit sponsored disclosure.

```json
{
  "callSid": "CA123",
  "intent": "I need dishwasher-safe kitchen scissors under ten dollars",
  "maxPrice": 10,
  "rejectedAsins": []
}
```

A successful response includes `eligible: true`, the selected product, match
terms, and `spokenCopy`. When no product is suitable or the call reaches its
frequency cap, it returns `eligible: false` with a machine-readable reason.
Set `AD_API_BEARER` in production and send it as an `Authorization: Bearer ...`
header to protect this endpoint.

Only catalog records explicitly marked `sponsored: true` are eligible. The
selector treats catalog text only as matching data, and spoken copy is generated
from a fixed template using the product brand, title, and price. A selection is
logged as a decision, not an impression; durable campaign and playback-event
storage remain future work.

## Injection demo

Open `/demo` for the one-button browser voice flow. The product-agent request
starts in parallel with a prefetched sponsor break. Tenstorrent Qwen selects the
most relevant ad from a compact inventory system prompt. Inworld TTS speaks both
the disclosed sponsor and the later agent response. The UI and debug JSON
preserve separate `injected_ad` and `llm_response` records.

```json
{
  "llmResponse": { "type": "llm_response", "text": "..." },
  "injectedAd": { "type": "injected_ad", "decisionId": "addec_..." },
  "segments": [
    { "type": "llm_response", "source": "demo_llm", "text": "..." },
    { "type": "injected_ad", "source": "ad_engine", "text": "..." },
    { "type": "llm_response", "source": "demo_llm", "text": "..." }
  ],
  "injection": { "happened": true, "segmentIndex": 1 }
}
```

`composedResponse.text` is derived from these segments, so the demo can show the
exact insertion boundary while still producing one string suitable for speech.

The `llmResponse` comes from one direct Inworld Chat Completions request. Sponsor
selection runs independently and concurrently; the response records the actual
model selected by Inworld when `INWORLD_LLM_MODEL=auto`.

## Callable demo

With `VOICE_MODE=demo`, an inbound Twilio call uses speech capture to ask what
the caller wants. `POST /twilio/respond` selects an ad, preserves the typed
`llm_response` and `injected_ad` segments internally, and returns TwiML that
speaks those segments in order with a pause around the sponsored insertion.

Set the Twilio number's incoming voice webhook to:

```text
POST $PUBLIC_BASE_URL/twilio/voice
```

Set `VOICE_MODE=stream` to restore the direct Twilio Media Stream to Inworld STT.

## Important format detail

Twilio Media Streams deliver raw, headerless `audio/x-mulaw` at 8 kHz. Inworld's
standalone streaming STT endpoint accepts LINEAR16 audio. The bridge decodes each
mu-law frame and sends signed 16-bit little-endian samples at 16 kHz. Upsampling
does not restore frequencies missing from telephone audio; it only satisfies the
required streaming input format.
