import crypto from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import { twilioMulaw8kToLinear16k } from "./audio.js";
import {
  loadProductCatalog,
  selectRandomSponsoredProduct,
  selectSponsoredProduct,
} from "./ads.js";
import { composeDemoTurn } from "./composer.js";
import {
  buildGatherTwiML,
  buildRetryTwiML,
  buildSpokenTurnTwiML,
  parseSpokenBudget,
} from "./voice-demo.js";

const requiredEnvironment = ["INWORLD_API_KEY", "TWILIO_AUTH_TOKEN", "PUBLIC_BASE_URL"];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());

if (missingEnvironment.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 8080);
const publicBaseUrl = process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
const publicWebSocketBaseUrl = publicBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const inworldApiKey = process.env.INWORLD_API_KEY;
const inworldTtsModel = process.env.INWORLD_TTS_MODEL?.trim() || "inworld-tts-2";
const inworldTtsSponsorVoice = process.env.INWORLD_TTS_SPONSOR_VOICE?.trim() || "Dennis";
const inworldTtsAgentVoice = process.env.INWORLD_TTS_AGENT_VOICE?.trim() || "Ashley";
const inworldLlmModel = process.env.INWORLD_LLM_MODEL?.trim() || "auto";
const sttLanguage = process.env.STT_LANGUAGE || "en-US";
const transcriptWebhookUrl = process.env.TRANSCRIPT_WEBHOOK_URL?.trim();
const transcriptWebhookBearer = process.env.TRANSCRIPT_WEBHOOK_BEARER?.trim();
const adApiBearer = process.env.AD_API_BEARER?.trim();
const voiceMode = process.env.VOICE_MODE?.trim() || "demo";
const productCatalogPath = process.env.PRODUCT_CATALOG_PATH
  || new URL("../data/products/brightdata-amazon-2026-08-01.products.json", import.meta.url);
const adFrequencyCap = Number(process.env.AD_FREQUENCY_CAP || 2);
if (!Number.isInteger(adFrequencyCap) || adFrequencyCap < 1) {
  throw new Error("AD_FREQUENCY_CAP must be a positive integer");
}
const products = await loadProductCatalog(productCatalogPath);
const adSessions = new Map();
let lastDemoSponsoredAsin;
const demoAssets = {
  "/": ["demo.html", "text/html; charset=utf-8"],
  "/demo": ["demo.html", "text/html; charset=utf-8"],
  "/demo.css": ["demo.css", "text/css; charset=utf-8"],
  "/demo.js": ["demo.js", "text/javascript; charset=utf-8"],
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && demoAssets[request.url]) {
      const [fileName, contentType] = demoAssets[request.url];
      const contents = await readFile(new URL(`../public/${fileName}`, import.meta.url));
      response.writeHead(200, { "Content-Type": contentType });
      response.end(contents);
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      return writeJson(response, 200, {
        status: "ok",
        model: "inworld/inworld-stt-1",
        products: products.length,
      });
    }

    if (request.method === "POST" && request.url === "/ads/select") {
      if (adApiBearer && request.headers.authorization !== `Bearer ${adApiBearer}`) {
        return writeJson(response, 401, { error: "Invalid ad API credential" });
      }
      const input = await readJsonBody(request);
      const callSid = input.callSid?.trim();
      if (!callSid) return writeJson(response, 400, { error: "callSid is required" });
      if (input.rejectedAsins != null && !Array.isArray(input.rejectedAsins)) {
        return writeJson(response, 400, { error: "rejectedAsins must be an array" });
      }

      const session = getAdSession(callSid);
      for (const asin of input.rejectedAsins || []) session.rejectedAsins.add(asin);
      if (session.decisions >= adFrequencyCap) {
        return writeJson(response, 200, {
          type: "ad.selection",
          eligible: false,
          reason: "frequency_cap",
        });
      }

      const selection = selectSponsoredProduct(products, {
        ...input,
        rejectedAsins: [...session.rejectedAsins],
        shownAsins: [...session.shownAsins],
      });
      if (!selection) {
        return writeJson(response, 200, {
          type: "ad.selection",
          eligible: false,
          reason: "no_match",
        });
      }

      session.shownAsins.add(selection.product.asin);
      session.decisions += 1;
      session.updatedAt = Date.now();
      console.log(JSON.stringify({
        type: "ad.decision",
        callSid,
        asin: selection.product.asin,
        disclosure: selection.disclosure,
        occurredAt: new Date().toISOString(),
      }));
      return writeJson(response, 200, { callSid, ...selection });
    }

    if (request.method === "POST" && request.url === "/api/demo/sponsor") {
      const input = await readJsonBody(request);
      const callSid = input.callSid?.trim();
      if (!callSid) return writeJson(response, 400, { error: "callSid is required" });

      const selection = selectRandomSponsoredProduct(
        products,
        lastDemoSponsoredAsin ? [lastDemoSponsoredAsin] : [],
      );
      if (!selection) return writeJson(response, 404, { error: "No sponsored inventory available" });
      lastDemoSponsoredAsin = selection.product.asin;

      const injectedAd = {
        id: `ad_${crypto.randomUUID()}`,
        type: "injected_ad",
        source: "ad_engine",
        disclosure: selection.disclosure,
        text: selection.breakCopy,
        product: selection.product,
        match: selection.match,
      };
      return writeJson(response, 200, {
        type: "sponsor_break",
        callSid,
        phase: "fetching_web_results",
        injectedAd,
        segments: [injectedAd],
      });
    }

    if (request.method === "POST" && request.url === "/api/tts") {
      const input = await readJsonBody(request);
      const text = input.text?.trim();
      if (!text) return writeJson(response, 400, { error: "text is required" });
      if (text.length > 2000) return writeJson(response, 400, { error: "text exceeds 2,000 characters" });
      if (input.role !== "sponsor" && input.role !== "agent") {
        return writeJson(response, 400, { error: "role must be sponsor or agent" });
      }

      const voiceId = input.role === "sponsor"
        ? inworldTtsSponsorVoice
        : inworldTtsAgentVoice;
      const audio = await synthesizeInworldSpeech(text, voiceId);
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": audio.byteLength,
        "Cache-Control": "no-store",
        "X-TTS-Provider": "inworld",
        "X-TTS-Model": inworldTtsModel,
        "X-TTS-Voice": voiceId,
      });
      response.end(audio);
      return;
    }

    if (request.method === "POST" && request.url === "/api/demo/turn") {
      const input = await readJsonBody(request);
      const callSid = input.callSid?.trim();
      const transcript = input.transcript?.trim();
      if (!callSid) return writeJson(response, 400, { error: "callSid is required" });
      if (!transcript) return writeJson(response, 400, { error: "transcript is required" });

      const selection = input.suppressAd
        ? { eligible: false, reason: "sponsor_break_already_served" }
        : selectSponsoredProduct(products, {
          intent: transcript,
          maxPrice: input.maxPrice,
        });
      const turnId = `turn_${crypto.randomUUID()}`;
      const llm = await generateInworldResponse(transcript);
      const turn = composeDemoTurn({
        callSid,
        transcript,
        turnId,
        llmText: llm.text,
        llmSource: llm.source,
        llmModel: llm.model,
        selection: selection || { eligible: false, reason: "no_match" },
      });
      console.log(JSON.stringify({
        type: "demo.turn",
        turnId,
        callSid,
        injectionHappened: turn.injection.happened,
        segmentTypes: turn.segments.map((segment) => segment.type),
      }));
      return writeJson(response, 200, turn);
    }

    if (request.method === "POST" && request.url === "/twilio/voice") {
      const body = await readRequestBody(request);
      const params = Object.fromEntries(new URLSearchParams(body));
      const exactUrl = `${publicBaseUrl}/twilio/voice`;

      if (!isValidTwilioSignature(request.headers["x-twilio-signature"], exactUrl, params)) {
        return writeJson(response, 403, { error: "Invalid Twilio signature" });
      }

      if (voiceMode === "demo") {
        return writeXml(response, 200, buildGatherTwiML({
          actionUrl: `${publicBaseUrl}/twilio/respond`,
        }));
      }

      const streamUrl = `${publicWebSocketBaseUrl}/twilio/media`;
      response.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Response><Connect><Stream url="${escapeXml(streamUrl)}" /></Connect></Response>`,
      );
      return;
    }

    if (request.method === "POST" && request.url === "/twilio/respond") {
      const body = await readRequestBody(request);
      const params = Object.fromEntries(new URLSearchParams(body));
      const exactUrl = `${publicBaseUrl}/twilio/respond`;
      if (!isValidTwilioSignature(request.headers["x-twilio-signature"], exactUrl, params)) {
        return writeJson(response, 403, { error: "Invalid Twilio signature" });
      }

      const transcript = params.SpeechResult?.trim();
      if (!transcript) {
        return writeXml(response, 200, buildRetryTwiML({
          voiceUrl: `${publicBaseUrl}/twilio/voice`,
        }));
      }

      const callSid = params.CallSid || `call_${crypto.randomUUID()}`;
      const selection = selectSponsoredProduct(products, {
        intent: transcript,
        maxPrice: parseSpokenBudget(transcript),
      });
      const llm = await generateInworldResponse(transcript);
      const turn = composeDemoTurn({
        callSid,
        transcript,
        turnId: `turn_${crypto.randomUUID()}`,
        selection: selection || { eligible: false, reason: "no_match" },
        llmText: llm.text,
        llmSource: llm.source,
        llmModel: llm.model,
      });
      console.log(JSON.stringify({
        type: "voice.demo.turn",
        callSid,
        transcript,
        injectionHappened: turn.injection.happened,
        segmentTypes: turn.segments.map((segment) => segment.type),
      }));
      return writeXml(response, 200, buildSpokenTurnTwiML(turn));
    }

    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof TypeError) {
      return writeJson(response, 400, { error: error.message });
    }
    console.error("HTTP error", error);
    writeJson(response, 500, { error: "Internal server error" });
  }
});

async function synthesizeInworldSpeech(text, voiceId) {
  const ttsResponse = await fetch("https://api.inworld.ai/tts/v1/voice", {
    method: "POST",
    headers: {
      Authorization: `Basic ${inworldApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voiceId,
      modelId: inworldTtsModel,
      audioConfig: {
        audioEncoding: "LINEAR16",
        sampleRateHertz: 22050,
      },
      deliveryMode: "BALANCED",
      applyTextNormalization: "ON",
    }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await ttsResponse.json();
  if (!ttsResponse.ok || !payload.audioContent) {
    const detail = payload.message || payload.error?.message || `HTTP ${ttsResponse.status}`;
    throw new Error(`Inworld TTS failed: ${detail}`);
  }
  return Buffer.from(payload.audioContent, "base64");
}

async function generateInworldResponse(message) {
  const llmResponse = await fetch("https://api.inworld.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${inworldApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: inworldLlmModel,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: "Answer the user's request directly in two concise sentences. Do not mention ads or claim to have searched the live web.",
        },
        { role: "user", content: message },
      ],
      extra_body: { sort: ["price"] },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await llmResponse.json();
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!llmResponse.ok || !text) {
    const detail = payload.error?.message || `HTTP ${llmResponse.status}`;
    throw new Error(`Inworld LLM failed: ${detail}`);
  }
  return {
    text,
    model: payload.model || inworldLlmModel,
    source: "inworld_chat_completions",
  };
}

const twilioWebSocketServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path !== "/twilio/media") {
    socket.destroy();
    return;
  }

  const exactUrl = `${publicWebSocketBaseUrl}/twilio/media`;
  const signature = request.headers["x-twilio-signature"];
  if (!isValidTwilioSignature(signature, exactUrl, {})) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  twilioWebSocketServer.handleUpgrade(request, socket, head, (twilioSocket) => {
    twilioWebSocketServer.emit("connection", twilioSocket, request);
  });
});

twilioWebSocketServer.on("connection", (twilioSocket) => {
  const inworldSocket = new WebSocket(
    "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional",
    { headers: { Authorization: `Basic ${inworldApiKey}` } },
  );

  let streamSid;
  let callSid;
  let inworldReady = false;
  let streamClosing = false;
  const pendingAudio = [];

  inworldSocket.on("open", () => {
    inworldSocket.send(JSON.stringify({
      transcribeConfig: {
        modelId: "inworld/inworld-stt-1",
        language: sttLanguage,
        audioEncoding: "LINEAR16",
        sampleRateHertz: 16000,
        numberOfChannels: 1,
      },
    }));
    inworldReady = true;
    while (pendingAudio.length > 0 && inworldSocket.readyState === WebSocket.OPEN) {
      sendAudioToInworld(inworldSocket, pendingAudio.shift());
    }
  });

  inworldSocket.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      console.warn("Ignored non-JSON Inworld message");
      return;
    }

    if (event.transcription) {
      const transcriptEvent = {
        callSid,
        streamSid,
        text: event.transcription.transcript || "",
        isFinal: Boolean(event.transcription.isFinal),
        wordTimestamps: event.transcription.wordTimestamps || [],
        receivedAt: new Date().toISOString(),
      };
      console.log(JSON.stringify({ type: "transcription", ...transcriptEvent }));
      deliverTranscript(transcriptEvent).catch((error) => {
        console.error("Transcript webhook failed", error.message);
      });
    } else if (event.code || event.error) {
      console.error("Inworld STT error", event);
    }
  });

  inworldSocket.on("error", (error) => {
    console.error("Inworld WebSocket error", { callSid, message: error.message });
    twilioSocket.close(1011, "STT provider error");
  });

  inworldSocket.on("close", () => {
    if (twilioSocket.readyState === WebSocket.OPEN) twilioSocket.close(1011, "STT stream closed");
  });

  twilioSocket.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      console.warn("Ignored malformed Twilio message");
      return;
    }

    if (event.event === "start") {
      streamSid = event.start?.streamSid;
      callSid = event.start?.callSid;
      console.log(JSON.stringify({ type: "call.started", callSid, streamSid }));
      return;
    }

    if (event.event === "media" && event.media?.payload) {
      const linear16kAudio = twilioMulaw8kToLinear16k(event.media.payload);
      if (inworldReady && inworldSocket.readyState === WebSocket.OPEN) {
        sendAudioToInworld(inworldSocket, linear16kAudio);
      } else if (pendingAudio.length < 250) {
        pendingAudio.push(linear16kAudio);
      }
      return;
    }

    if (event.event === "stop") closeInworldStream();
  });

  twilioSocket.on("close", closeInworldStream);
  twilioSocket.on("error", (error) => {
    console.error("Twilio WebSocket error", { callSid, message: error.message });
    closeInworldStream();
  });

  function closeInworldStream() {
    if (streamClosing) return;
    streamClosing = true;
    if (inworldSocket.readyState === WebSocket.OPEN) {
      inworldSocket.send(JSON.stringify({ closeStream: {} }));
      setTimeout(() => inworldSocket.close(1000), 1000).unref();
    } else if (inworldSocket.readyState === WebSocket.CONNECTING) {
      inworldSocket.close();
    }
  }
});

server.listen(port, () => {
  console.log(`Phone-call STT bridge listening on port ${port}`);
  console.log(`Configure Twilio inbound voice webhook: ${publicBaseUrl}/twilio/voice`);
});

function sendAudioToInworld(socket, base64Linear16Audio) {
  socket.send(JSON.stringify({ audioChunk: { content: base64Linear16Audio } }));
}

async function deliverTranscript(event) {
  if (!transcriptWebhookUrl) return;
  const headers = { "Content-Type": "application/json" };
  if (transcriptWebhookBearer) headers.Authorization = `Bearer ${transcriptWebhookBearer}`;
  const response = await fetch(transcriptWebhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

function isValidTwilioSignature(providedSignature, exactUrl, params) {
  if (!providedSignature) return false;
  const sortedKeys = Object.keys(params).sort();
  const payload = sortedKeys.reduce((value, key) => value + key + params[key], exactUrl);
  const expected = crypto.createHmac("sha1", twilioAuthToken).update(payload).digest("base64");
  const provided = Buffer.from(providedSignature);
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);
  try {
    return JSON.parse(body);
  } catch {
    throw new TypeError("Invalid JSON body");
  }
}

function getAdSession(callSid) {
  const now = Date.now();
  for (const [sessionCallSid, session] of adSessions) {
    if (now - session.updatedAt > 4 * 60 * 60 * 1000) adSessions.delete(sessionCallSid);
  }
  const existing = adSessions.get(callSid);
  if (existing) return existing;

  const session = {
    decisions: 0,
    shownAsins: new Set(),
    rejectedAsins: new Set(),
    updatedAt: now,
  };
  adSessions.set(callSid, session);
  return session;
}

function writeJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeXml(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "text/xml; charset=utf-8" });
  response.end(body);
}

function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]);
}
