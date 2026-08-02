# Conversational Ad Injection Platform — Implementation Plan

## Product positioning

This product is sold primarily as an **ad injection platform for AI-powered
phone conversations**.

It enables retailers, marketplaces, and brands to place contextually relevant
product advertisements inside live voice-agent interactions. The platform
listens to the customer's expressed shopping intent, selects an eligible
campaign and real product, and provides a sponsored segment for the voice agent
to insert into the conversation.

The voice assistant is the delivery channel. Product assistance improves the
customer experience, while contextual ad injection, campaign controls,
impression tracking, and conversion attribution are the platform's main
commercial product.

### Primary customers

- Retailers and marketplaces operating phone-based shopping agents.
- Brands that want measurable sponsored product placement in voice commerce.
- Contact-center and voice-agent platforms that need an advertising layer.
- Shopkeeper software providers that want to monetize automated customer calls.

### Core platform outputs

- A contextually matched sponsored product.
- Approved spoken advertisement copy.
- The required sponsored label.
- Placement and frequency-control decisions.
- Impression, rejection, click, and conversion events.
- Campaign and merchant attribution.

## Original product idea

Build an ad-supported AI phone agent for shopkeepers and online sellers. A
customer calls a normal phone number, speaks naturally with the agent, and
receives help finding and buying real products. The core commercial feature is
injecting relevant product advertisements into that live conversation.

### Core differentiator — conversational ad injection

The platform selects a paid product that matches the customer's current request
and inserts it into the agent's response as a short sponsored recommendation.
The ad is generated from real product data and campaign rules rather than a
generic prerecorded commercial.

Example:

> “I found two headphones under fifty dollars. Before the comparison, here is a
> sponsored suggestion from Acme Audio: their X2 model is currently forty-five
> dollars and matches your wireless requirement.”

The injection layer will eventually:

- Detect an eligible moment in the conversation.
- Match the caller's expressed intent with real advertised products.
- Check price, availability, category, and campaign eligibility.
- Insert a concise sponsored segment into the response.
- Identify the segment as sponsored when it is spoken.
- Avoid repeating an advertisement the caller rejected.
- Record the ad impression, product, campaign, call, and resulting action.
- Attribute checkout-link clicks or purchases to the injected advertisement.

The complete product concept is:

- Receive customer calls through a real telephone number.
- Understand what the customer wants, including category, budget, features,
  availability, and delivery preferences.
- Search real product information supplied through merchant APIs or the selected
  Bright Data dataset.
- Compare suitable products and explain the differences conversationally.
- Inject relevant paid product placements as clearly identified sponsored
  suggestions during the conversation.
- Send the customer a secure product or checkout link.
- Eventually support order status, returns, and transfer to a human shopkeeper.

```text
Customer phone call
  → Twilio phone number
  → voice agent
  → speech-to-text
  → product search and ad-selection engine
  → contextual sponsored-message injection
  → organic and sponsored product options
  → spoken response or checkout link
```

The current implementation includes telephone and browser speech input, product
agent lookup, random sponsor-break selection, typed ad/LLM provenance, and
separate Inworld TTS calls for the sponsor and agent response. Checkout and
conversion attribution remain future work.

## Goal

Build one service where a customer can speak in a browser or call a Twilio
number, receive product assistance, and hear a clearly disclosed sponsor while
the product lookup runs. Keep sponsored and agent-generated content separately
typed throughout the response pipeline.

## Data flow

```text
Actual mobile phone or landline
  → Twilio phone number
  → Twilio inbound voice webhook
  → Twilio bidirectional Media Stream
  → G.711 mu-law 8 kHz audio
  → LINEAR16 PCM 16 kHz conversion
  → Inworld streaming STT
  → partial and final transcript events
  → JSON logs and optional transcript webhook
```

## Required credentials

The service needs these values in a local `.env` file:

```dotenv
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
INWORLD_API_KEY=
PUBLIC_BASE_URL=
PORT=8080
STT_LANGUAGE=en-US
```

- `TWILIO_AUTH_TOKEN` validates Twilio HTTP and WebSocket signatures.
- `INWORLD_API_KEY` is the Base64 credential from Inworld Settings → API Keys.
- `PUBLIC_BASE_URL` is the public HTTPS origin that Twilio can reach.
- Credentials must never be committed or embedded in source code.

## Phase 1 — Local service

- Start a Node.js HTTP and WebSocket server.
- Expose `GET /health`.
- Expose `POST /twilio/voice` for Twilio's inbound-call webhook.
- Return TwiML that connects the call to `WSS /twilio/media`.
- Refuse to start when required credentials are missing.

### Completion criteria

- The service starts with valid environment variables.
- The health endpoint reports `inworld/inworld-stt-1`.
- Invalid Twilio signatures are rejected.

## Phase 2 — Telephone audio ingestion

- Accept Twilio `connected`, `start`, `media`, and `stop` WebSocket events.
- Capture the Twilio `CallSid` and `StreamSid`.
- Read each base64-encoded G.711 mu-law audio frame.
- Decode the frame into signed 16-bit PCM.
- Send the audio as mono LINEAR16 at 16 kHz.
- Close provider connections when the phone call ends.

### Completion criteria

- Every audio frame is associated with the correct call and stream.
- No WAV headers or other container bytes are sent to Inworld.
- Connections and buffered audio are released after the call stops.

## Phase 3 — Inworld streaming STT

- Connect to:

```text
wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional
```

- Authenticate with `Authorization: Basic $INWORLD_API_KEY`.
- Send `transcribeConfig` as the first message:

```json
{
  "transcribeConfig": {
    "modelId": "inworld/inworld-stt-1",
    "language": "en-US",
    "audioEncoding": "LINEAR16",
    "sampleRateHertz": 16000,
    "numberOfChannels": 1
  }
}
```

- Stream audio using `audioChunk` messages.
- Process interim and final `transcription` results.
- Send `closeStream` when Twilio ends the call.

### Completion criteria

- Live caller speech produces partial transcript events.
- Completed phrases produce `isFinal: true` events.
- Authentication and provider errors are logged without exposing secrets.

## Phase 4 — Transcript delivery

- Write each transcript as one structured JSON log line.
- Include `CallSid`, `StreamSid`, transcript text, finality, timestamps, and
  receipt time.
- Optionally POST each event to `TRANSCRIPT_WEBHOOK_URL`.
- Optionally protect the receiving webhook with
  `TRANSCRIPT_WEBHOOK_BEARER`.

Example event:

```json
{
  "type": "transcription",
  "callSid": "CA...",
  "streamSid": "MZ...",
  "text": "I am looking for wireless headphones",
  "isFinal": true,
  "wordTimestamps": [],
  "receivedAt": "2026-08-01T20:00:00.000Z"
}
```

## Phase 5 — Public deployment and Twilio setup

- Deploy the service behind public HTTPS and secure WebSocket support.
- Set `PUBLIC_BASE_URL` to the deployed origin.
- Configure the Twilio phone number's **A call comes in** setting:

```text
Method: POST
URL: https://YOUR_HOST/twilio/voice
```

- Call the Twilio number from an allowed phone.
- Confirm that transcript events appear while the caller speaks.

## Current implementation status

- Node.js service structure: complete.
- Twilio inbound webhook: complete.
- Twilio Media Stream ingestion: complete.
- Telephone audio conversion: complete.
- Inworld streaming STT connection: complete.
- Transcript JSON and optional webhook output: complete.
- Browser voice interface and raw JSON debugger: complete.
- Random sponsor break during parallel product lookup: complete.
- Inworld TTS for separate sponsor and agent audio calls: complete.
- Direct Inworld Chat Completions integration: complete.
- Live Inworld TTS provider verification: complete.
- Public tunnel and configured Twilio phone number: pending.
