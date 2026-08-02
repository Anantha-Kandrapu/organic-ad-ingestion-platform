import crypto from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import { twilioMulaw8kToLinear16k } from "./audio.js";
import { sendToAgent } from "./agent-client.js";

const requiredEnvironment = ["INWORLD_API_KEY"];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());
if (missingEnvironment.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 8080);
const inworldApiKey = process.env.INWORLD_API_KEY;
const inworldTtsModel = process.env.INWORLD_TTS_MODEL?.trim() || "inworld-tts-2";
const inworldTtsAgentVoice = process.env.INWORLD_TTS_AGENT_VOICE?.trim() || "Ashley";
const sttLanguage = process.env.STT_LANGUAGE || "en-US";
const wholesaleAgentUrl = (process.env.WHOLESALE_AGENT_URL?.trim() || "http://127.0.0.1:8000");
const transcriptWebhookUrl = process.env.TRANSCRIPT_WEBHOOK_URL?.trim();
const transcriptWebhookBearer = process.env.TRANSCRIPT_WEBHOOK_BEARER?.trim();
// Twilio phone STT is optional; enabled only when an auth token is present.
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim();
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");

const staticAssets = {
  "/": ["voice.html", "text/html; charset=utf-8"],
  "/voice": ["voice.html", "text/html; charset=utf-8"],
  "/voice.js": ["voice.js", "text/javascript; charset=utf-8"],
  "/voice.css": ["voice.css", "text/css; charset=utf-8"],
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && staticAssets[request.url]) {
      const [fileName, contentType] = staticAssets[request.url];
      const contents = await readFile(new URL(`../public/${fileName}`, import.meta.url));
      response.writeHead(200, { "Content-Type": contentType });
      response.end(contents);
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      return writeJson(response, 200, {
        status: "ok",
        stt: "inworld/inworld-stt-1",
        tts: inworldTtsModel,
        agent: wholesaleAgentUrl,
      });
    }

    // Text-to-speech passthrough (used by the browser to speak agent replies).
    if (request.method === "POST" && request.url === "/api/tts") {
      const input = await readJsonBody(request);
      const text = input.text?.trim();
      if (!text) return writeJson(response, 400, { error: "text is required" });
      if (text.length > 4000) return writeJson(response, 400, { error: "text exceeds 4000 chars" });
      const audio = await synthesizeInworldSpeech(text, inworldTtsAgentVoice);
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": audio.byteLength,
        "Cache-Control": "no-store",
      });
      response.end(audio);
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof TypeError) return writeJson(response, 400, { error: error.message });
    console.error("HTTP error", error);
    writeJson(response, 500, { error: "Internal server error" });
  }
});

// --- Inworld streaming STT session (shared by browser + Twilio) ----------------

function createInworldSttSession({ onTranscript, onError }) {
  const socket = new WebSocket(
    "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional",
    { headers: { Authorization: `Basic ${inworldApiKey}` } },
  );
  let ready = false;
  let closing = false;
  const pending = [];

  socket.on("open", () => {
    socket.send(JSON.stringify({
      transcribeConfig: {
        modelId: "inworld/inworld-stt-1",
        language: sttLanguage,
        audioEncoding: "LINEAR16",
        sampleRateHertz: 16000,
        numberOfChannels: 1,
      },
    }));
    ready = true;
    while (pending.length > 0 && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ audioChunk: { content: pending.shift() } }));
    }
  });

  socket.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Inworld wraps every event in `result`: transcription, speechStarted/Stopped, usage.
    const transcription = event.result?.transcription;
    if (transcription) {
      onTranscript({
        text: transcription.transcript || "",
        isFinal: Boolean(transcription.isFinal),
      });
    } else if (event.error || event.result?.error) {
      console.error("Inworld STT error", event.error || event.result?.error);
    }
  });

  socket.on("error", (error) => {
    console.error("Inworld STT socket error", error.message);
    onError?.(error);
  });

  return {
    sendPcmBase64(base64Linear16) {
      if (closing) return;
      if (ready && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ audioChunk: { content: base64Linear16 } }));
      } else if (pending.length < 400) {
        pending.push(base64Linear16);
      }
    },
    close() {
      if (closing) return;
      closing = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ closeStream: {} }));
        setTimeout(() => socket.close(1000), 500).unref();
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}

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
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 22050 },
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

// --- WebSocket routing ---------------------------------------------------------

const browserVoiceServer = new WebSocketServer({ noServer: true });
const twilioMediaServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/voice/media") {
    browserVoiceServer.handleUpgrade(request, socket, head, (client) => {
      browserVoiceServer.emit("connection", client, request);
    });
  } else if (path === "/twilio/media" && twilioAuthToken) {
    twilioMediaServer.handleUpgrade(request, socket, head, (client) => {
      twilioMediaServer.emit("connection", client, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Browser continuous voice loop: mic -> STT -> agent -> TTS -> browser ------

browserVoiceServer.on("connection", (client) => {
  let conversationId = null;
  let assistantCount = 0;
  let busy = false; // true while the agent is thinking / speaking
  const send = (message) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };

  const stt = createInworldSttSession({
    onTranscript: async ({ text, isFinal }) => {
      if (!text.trim()) return;
      if (!isFinal) {
        send({ type: "partial_transcript", text });
        return;
      }
      if (busy) return; // ignore speech captured while the agent is responding
      busy = true;
      send({ type: "user_transcript", text });
      send({ type: "status", state: "thinking" });
      try {
        const reply = await sendToAgent({
          baseUrl: wholesaleAgentUrl,
          conversationId,
          priorAssistantCount: assistantCount,
          message: text,
        });
        conversationId = reply.conversationId;
        assistantCount = reply.assistantCount;
        send({
          type: "agent_text",
          text: reply.text,
          emotion: reply.emotion,
          satisfaction: reply.satisfaction,
          offerPreference: reply.offerPreference,
        });
        send({ type: "status", state: "speaking" });
        const audio = await synthesizeInworldSpeech(reply.text, inworldTtsAgentVoice);
        send({ type: "agent_audio", format: "wav", data: audio.toString("base64") });
      } catch (error) {
        console.error("Voice turn failed", error.message);
        send({ type: "error", message: error.message });
        send({ type: "status", state: "listening" });
        busy = false;
      }
    },
    onError: (error) => send({ type: "error", message: `STT: ${error.message}` }),
  });

  client.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (event.type === "audio" && typeof event.data === "string") {
      if (!busy) stt.sendPcmBase64(event.data); // don't feed mic audio while speaking
    } else if (event.type === "playback_done") {
      // Browser finished playing the reply; resume listening.
      busy = false;
      send({ type: "status", state: "listening" });
    }
  });

  client.on("close", () => stt.close());
  client.on("error", () => stt.close());

  send({ type: "status", state: "listening" });
});

// --- Twilio phone STT (optional, no ads): media stream -> Inworld STT ----------

twilioMediaServer.on("connection", (client) => {
  let streamSid;
  let callSid;
  const stt = createInworldSttSession({
    onTranscript: ({ text, isFinal }) => {
      if (!text.trim()) return;
      const event = { callSid, streamSid, text, isFinal, receivedAt: new Date().toISOString() };
      console.log(JSON.stringify({ type: "transcription", ...event }));
      if (isFinal) deliverTranscript(event).catch((e) => console.error("webhook failed", e.message));
    },
    onError: () => client.close(1011, "STT error"),
  });

  client.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (event.event === "start") {
      streamSid = event.start?.streamSid;
      callSid = event.start?.callSid;
    } else if (event.event === "media" && event.media?.payload) {
      stt.sendPcmBase64(twilioMulaw8kToLinear16k(event.media.payload));
    } else if (event.event === "stop") {
      stt.close();
    }
  });
  client.on("close", () => stt.close());
  client.on("error", () => stt.close());
});

server.listen(port, () => {
  console.log(`Voice sales agent listening on http://localhost:${port}  (open /voice)`);
  console.log(`Agent backend: ${wholesaleAgentUrl}`);
  if (twilioAuthToken && publicBaseUrl) {
    console.log(`Twilio media stream enabled at ${publicBaseUrl.replace(/^http/, "ws")}/twilio/media`);
  }
});

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

function writeJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new TypeError("Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TypeError("Invalid JSON body");
  }
}

// Silence unused-crypto lint if Twilio validation is later re-added.
void crypto;
