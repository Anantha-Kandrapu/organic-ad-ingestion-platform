# Phone call → Inworld STT bridge

This service does one job: it receives an inbound Twilio phone-call audio stream,
converts Twilio's 8 kHz G.711 mu-law frames to the 16 kHz LINEAR16 format required
by Inworld streaming STT, and emits transcript events from
`inworld/inworld-stt-1`.

It does not answer questions, speak to the caller, search products, inject ads,
or place orders.

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

## Important format detail

Twilio Media Streams deliver raw, headerless `audio/x-mulaw` at 8 kHz. Inworld's
standalone streaming STT endpoint accepts LINEAR16 audio. The bridge decodes each
mu-law frame and sends signed 16-bit little-endian samples at 16 kHz. Upsampling
does not restore frequencies missing from telephone audio; it only satisfies the
required streaming input format.
