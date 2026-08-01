import crypto from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { twilioMulaw8kToLinear16k } from "./audio.js";

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
const sttLanguage = process.env.STT_LANGUAGE || "en-US";
const transcriptWebhookUrl = process.env.TRANSCRIPT_WEBHOOK_URL?.trim();
const transcriptWebhookBearer = process.env.TRANSCRIPT_WEBHOOK_BEARER?.trim();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return writeJson(response, 200, { status: "ok", model: "inworld/inworld-stt-1" });
    }

    if (request.method === "POST" && request.url === "/twilio/voice") {
      const body = await readRequestBody(request);
      const params = Object.fromEntries(new URLSearchParams(body));
      const exactUrl = `${publicBaseUrl}/twilio/voice`;

      if (!isValidTwilioSignature(request.headers["x-twilio-signature"], exactUrl, params)) {
        return writeJson(response, 403, { error: "Invalid Twilio signature" });
      }

      const streamUrl = `${publicWebSocketBaseUrl}/twilio/media`;
      response.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Response><Connect><Stream url="${escapeXml(streamUrl)}" /></Connect></Response>`,
      );
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("HTTP error", error);
    writeJson(response, 500, { error: "Internal server error" });
  }
});

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

function writeJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
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
