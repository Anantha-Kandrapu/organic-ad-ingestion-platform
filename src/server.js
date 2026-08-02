import http from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
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
// A different Inworld voice for sponsor ads when Tenstorrent is unavailable.
const inworldSponsorVoice = process.env.INWORLD_TTS_SPONSOR_VOICE?.trim() || "Dennis";
// Tenstorrent-hosted TTS (Inworld-compatible). When a key is present, agent
// replies are synthesized on Tenstorrent; otherwise Inworld is called directly.
const tenstorrentApiKey = process.env.TENSTORRENT_API_KEY?.trim();
const tenstorrentBaseUrl = (process.env.TENSTORRENT_BASE_URL?.trim()
  || "https://console.tenstorrent.com").replace(/\/$/, "");
const tenstorrentTtsModel = process.env.TENSTORRENT_TTS_MODEL?.trim() || "inworld-tts-2";
const sttLanguage = process.env.STT_LANGUAGE || "en-US";
const wholesaleAgentUrl = (process.env.WHOLESALE_AGENT_URL?.trim() || "http://127.0.0.1:8000");

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
        tts: tenstorrentApiKey ? `tenstorrent/${tenstorrentTtsModel}` : inworldTtsModel,
        agent: wholesaleAgentUrl,
      });
    }

    // Text-to-speech passthrough (used by the browser to speak agent replies).
    if (request.method === "POST" && request.url === "/api/tts") {
      const input = await readJsonBody(request);
      const text = input.text?.trim();
      if (!text) return writeJson(response, 400, { error: "text is required" });
      if (text.length > 4000) return writeJson(response, 400, { error: "text exceeds 4000 chars" });
      const audio = await synthesizeAgentSpeech(text);
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

// --- Inworld streaming STT session ---------------------------------------------

const SILENCE_FRAME = Buffer.alloc(640).toString("base64"); // 320 samples of 16-bit silence

function createInworldSttSession({ onTranscript, onSpeechStarted, onError }) {
  const socket = new WebSocket(
    "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional",
    { headers: { Authorization: `Basic ${inworldApiKey}` } },
  );
  let ready = false;
  let closing = false;
  let lastActivity = Date.now();
  const pending = [];

  // Keep the socket warm during quiet stretches (e.g. while the agent speaks)
  // so a long-lived conversation's STT stream doesn't go stale between turns.
  const keepalive = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN && Date.now() - lastActivity > 700) {
      socket.send(JSON.stringify({ audioChunk: { content: SILENCE_FRAME } }));
    }
  }, 700);

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
    } else if (event.result?.speechStarted) {
      onSpeechStarted?.();
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
      lastActivity = Date.now();
      if (ready && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ audioChunk: { content: base64Linear16 } }));
      } else if (pending.length < 400) {
        pending.push(base64Linear16);
      }
    },
    close() {
      if (closing) return;
      closing = true;
      clearInterval(keepalive);
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

// Short fillers spoken immediately while the real reply is generated, so the
// gap between the user finishing and the agent answering isn't dead air.
const FILLER_PHRASES = [
  "Sure, let me pull that up for you.",
  "One moment, checking that now.",
  "Alright, let me take a quick look.",
  "Okay, give me just a second.",
];
const fillerCache = [];

async function warmFillers() {
  for (const phrase of FILLER_PHRASES) {
    try {
      const wav = await synthesizeAgentSpeech(phrase);
      fillerCache.push(wav.toString("base64"));
    } catch (error) {
      console.warn("Filler TTS warmup failed:", error.message);
      return;
    }
  }
}

function randomFiller() {
  if (!fillerCache.length) return null;
  return fillerCache[Math.floor(Math.random() * fillerCache.length)];
}

// Sponsored ads that fill the processing gap (in the sponsor voice), tagged with
// keywords for a similarity match. Synthesized once at startup and cached, so
// replaying them costs no TTS quota.
const GAP_ADS = [
  { keywords: ["dairy", "milk", "cheese", "cheddar"], text: "While I check that — today's featured deal: five percent off all dairy bulk orders over thirty units, from FreshFarm." },
  { keywords: ["water", "spring", "beverage", "drink", "aqua"], text: "One moment — a quick word from AquaPure: forty-plus cases of spring water ship free today." },
  { keywords: ["chip", "chips", "snack", "snacks", "potato", "crisp"], text: "Just a sec — SnackCo has potato chips at the week's lowest bulk price right now." },
  { keywords: ["rice", "grain", "grains", "basmati"], text: "Give me a moment — GoldenGrain basmati pallets come with a free display stand this week." },
  { keywords: ["cola", "soda", "soft drink", "beverage", "drink"], text: "Quick note — Cola Classic: buy two pallets today, get the third at twenty percent off." },
  { keywords: ["nut", "nuts", "snack", "snacks", "almond"], text: "One sec — NuttyCo: spend two hundred dollars on snacks and get eight percent back." },
];
const adClipCache = []; // { keywords, data }

// How often a turn gets a sponsored gap ad (the rest get a short filler).
const adProbability = Number(process.env.AD_PROBABILITY || 0.4);

async function warmAds() {
  for (const ad of GAP_ADS) {
    try {
      const wav = await synthesizeSponsorSpeech(ad.text);
      adClipCache.push({ keywords: ad.keywords, text: ad.text, data: wav.toString("base64") });
    } catch (error) {
      console.warn("Ad clip warmup failed:", error.message);
      return;
    }
  }
}

// Pick an ad by similarity to what the customer just said, with randomization so
// it isn't always the same one: score by keyword overlap, then choose randomly
// among the top-scoring ads (falling back to any ad when nothing clearly matches).
function pickAd(utterance) {
  if (!adClipCache.length) return null;
  const text = (utterance || "").toLowerCase();
  const scored = adClipCache.map((ad) => ({
    ad,
    score: ad.keywords.reduce((n, kw) => (text.includes(kw) ? n + 1 : n), 0),
  }));
  const maxScore = Math.max(...scored.map((s) => s.score));
  const pool = maxScore > 0
    ? scored.filter((s) => s.score > 0 && s.score >= maxScore - 1).map((s) => s.ad)
    : adClipCache;
  // Avoid repeating a recently-played ad: prefer relevant-and-fresh, then any
  // fresh ad, and only repeat as a last resort.
  const fresh = (arr) => arr.filter((a) => !recentAdTexts.includes(a.text));
  const choices = fresh(pool).length ? fresh(pool)
    : fresh(adClipCache).length ? fresh(adClipCache)
    : pool;
  const chosen = choices[Math.floor(Math.random() * choices.length)];
  recentAdTexts.push(chosen.text);
  if (recentAdTexts.length > 3) recentAdTexts.shift();
  return { data: chosen.data, text: chosen.text };
}
let recentAdTexts = [];

// Ada's own voice: Inworld (reliable, handles the conversation volume).
async function synthesizeAgentSpeech(text) {
  return synthesizeInworldSpeech(text, inworldTtsAgentVoice);
}

// Sponsor voice for ad copy: Tenstorrent (a distinct voice). On error or quota,
// fall back to a different Inworld voice so ads still sound distinct from Ada.
async function synthesizeSponsorSpeech(text) {
  if (tenstorrentApiKey) {
    try {
      return await synthesizeTenstorrentSpeech(text, sponsorVoice || inworldSponsorVoice);
    } catch (error) {
      console.warn("Tenstorrent sponsor TTS failed, using Inworld:", error.message);
    }
  }
  // Try the distinct Inworld sponsor voice; if that voice is invalid on this
  // account, fall back to the agent voice so the ad still plays.
  try {
    return await synthesizeInworldSpeech(text, inworldSponsorVoice);
  } catch (error) {
    console.warn("Inworld sponsor voice failed, using agent voice:", error.message);
    return synthesizeInworldSpeech(text, inworldTtsAgentVoice);
  }
}

// Tenstorrent OpenAI-compatible TTS. Input is capped (~150–180 words), so long
// replies are split into chunks and the returned WAVs are concatenated.
async function synthesizeTenstorrentSpeech(text, voiceId) {
  const wavs = [];
  for (const chunk of chunkForTts(text, 130)) {
    const response = await fetch(`${tenstorrentBaseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenstorrentApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: tenstorrentTtsModel,
        input: chunk,
        voice: voiceId,
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Tenstorrent TTS HTTP ${response.status} ${detail.slice(0, 200)}`);
    }
    wavs.push(Buffer.from(await response.arrayBuffer()));
  }
  if (wavs.length <= 1) return wavs[0] || Buffer.alloc(0);
  const parts = wavs.map(parseWav);
  return buildWav(parts[0], Buffer.concat(parts.map((p) => p.pcm)));
}

function chunkForTts(text, maxWords) {
  const sentences = text.match(/[^.!?\n]+[.!?\n]*\s*/g) || [text];
  const chunks = [];
  let current = "";
  let words = 0;
  for (const sentence of sentences) {
    const count = sentence.trim().split(/\s+/).filter(Boolean).length;
    if (words + count > maxWords && current) {
      chunks.push(current.trim());
      current = "";
      words = 0;
    }
    current += sentence;
    words += count;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

function parseWav(buf) {
  let offset = 12;
  let sampleRate = 22050;
  let channels = 1;
  let bits = 16;
  let pcm = Buffer.alloc(0);
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      pcm = buf.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  return { sampleRate, channels, bits, pcm };
}

function buildWav({ sampleRate, channels, bits }, pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Sponsor voice for ad copy — a different voice than the agent. Discovered from
// Tenstorrent's voice list, or set via TTS_SPONSOR_VOICE.
let sponsorVoice = process.env.TTS_SPONSOR_VOICE?.trim() || "";

async function discoverVoices() {
  if (tenstorrentApiKey) {
    try {
      const res = await fetch(
        `${tenstorrentBaseUrl}/v1/audio/voices?model=${encodeURIComponent(tenstorrentTtsModel)}`,
        { headers: { Authorization: `Bearer ${tenstorrentApiKey}` }, signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const ids = (data.voices || []).map((v) => v.voice_id).filter(Boolean);
      if (ids.length && (!sponsorVoice || !ids.includes(sponsorVoice) || sponsorVoice === inworldTtsAgentVoice)) {
        sponsorVoice = ids.find((id) => id !== inworldTtsAgentVoice) || inworldTtsAgentVoice;
      }
    } catch (error) {
      console.warn("Voice discovery failed:", error.message);
    }
  }
  if (!sponsorVoice) sponsorVoice = inworldTtsAgentVoice;
  console.log(`TTS voices: agent=${inworldTtsAgentVoice} sponsor=${sponsorVoice}`);
}

// Split a reply into [{text, ad}] on <ad>…</ad> markers so ad copy can be voiced
// with the sponsor voice while the agent's own words use the agent voice.
function splitAdSegments(text) {
  const segments = [];
  const re = /<ad>([\s\S]*?)<\/ad>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), ad: false });
    segments.push({ text: m[1], ad: true });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ text: text.slice(last), ad: false });
  return segments.length ? segments : [{ text, ad: false }];
}

function stripAdTags(text) {
  return text.replace(/<\/?ad>/gi, " ").replace(/\s+/g, " ").trim();
}

// Speak a reply, sending each segment as its own audio message. Ad segments use
// the sponsor voice. The browser plays segments back-to-back; sending them
// separately (rather than concatenating) avoids sample-rate mismatch between
// the Inworld agent voice and the Tenstorrent sponsor voice.
async function speakReply(send, text) {
  let segments = splitAdSegments(text).filter((s) => s.text.trim());
  if (!segments.length) segments = [{ text: stripAdTags(text) || "Okay.", ad: false }];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    let audio;
    try {
      audio = seg.ad
        ? await synthesizeSponsorSpeech(seg.text.trim())
        : await synthesizeAgentSpeech(seg.text.trim());
    } catch {
      audio = await synthesizeAgentSpeech(seg.text.trim());
    }
    send({
      type: "agent_audio",
      format: "wav",
      data: audio.toString("base64"),
      final: i === segments.length - 1,
    });
  }
}

// --- WebSocket routing ---------------------------------------------------------

const browserVoiceServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/voice/media") {
    browserVoiceServer.handleUpgrade(request, socket, head, (client) => {
      browserVoiceServer.emit("connection", client, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Browser continuous voice loop: mic -> STT -> agent -> TTS -> browser ------

browserVoiceServer.on("connection", (client) => {
  let conversationId = null;
  let busy = false; // agent is thinking/speaking; input is ignored until it finishes
  let turnCount = 0; // user turns so far this call
  let adsShown = 0; // sponsored ads played so far this call

  const send = (message) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const setState = (state) => send({ type: "status", state });

  // Turn-based: transcribe the user, run one agent turn, speak it, then listen
  // again. The mic is ignored while the agent is responding (no interruptions).
  const stt = createInworldSttSession({
    onTranscript: async ({ text, isFinal }) => {
      const clean = text.trim();
      if (!clean) return;
      if (!isFinal) {
        send({ type: "partial_transcript", text: clean });
        return;
      }
      if (busy || !isMeaningful(clean)) return; // one turn at a time; ignore noise
      busy = true;
      turnCount += 1;
      send({ type: "user_transcript", text: clean });
      setState("thinking");
      // Gap clip while thinking. Sponsored ads run only in the first two turns —
      // with at least one guaranteed by the 2nd message — and none after that,
      // where it's just a short generic filler.
      let showAd = false;
      if (turnCount <= 2) {
        showAd = Math.random() < adProbability;
        if (turnCount === 2 && adsShown === 0) showAd = true; // guarantee one by turn 2
      }
      if (showAd) {
        const ad = pickAd(clean);
        if (ad) {
          adsShown += 1;
          send({ type: "agent_audio", filler: true, ad: true, text: ad.text, data: ad.data });
        }
      } else {
        const f = randomFiller();
        if (f) send({ type: "agent_audio", filler: true, data: f });
      }
      try {
        const reply = await sendToAgent({
          baseUrl: wholesaleAgentUrl,
          conversationId,
          message: clean,
        });
        conversationId = reply.conversationId;
        send({
          type: "agent_text",
          text: stripAdTags(reply.text),
          emotion: reply.emotion,
          satisfaction: reply.satisfaction,
          offerPreference: reply.offerPreference,
        });
        setState("speaking");
        await speakReply(send, reply.text);
      } catch (error) {
        // Slow/failed turn: recover gracefully with a spoken prompt, not dead air.
        console.error("Voice turn failed", error.message);
        try {
          setState("speaking");
          await speakReply(send, "Sorry, I didn't catch that — could you say it again?");
        } catch {
          send({ type: "error", message: error.message });
          setState("listening");
          busy = false;
        }
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
      if (!busy) stt.sendPcmBase64(event.data); // don't listen while the agent responds
    } else if (event.type === "playback_done") {
      busy = false;
      setState("listening");
    }
  });

  client.on("close", () => stt.close());
  client.on("error", () => stt.close());

  // Opening greeting that includes a featured ad, spoken before the user talks.
  async function greet() {
    busy = true;
    setState("thinking");
    try {
      const reply = await sendToAgent({
        baseUrl: wholesaleAgentUrl,
        conversationId,
        message:
          "The customer just connected the call. Greet them warmly in one short "
          + "sentence and ask how you can help.",
      });
      conversationId = reply.conversationId;
      send({ type: "agent_text", text: stripAdTags(reply.text) });
      setState("speaking");
      await speakReply(send, reply.text);
    } catch (error) {
      console.error("Greeting failed:", error.message);
      setState("listening");
      busy = false;
    }
  }
  greet();
});

server.listen(port, () => {
  console.log(`Voice sales agent listening on http://localhost:${port}  (open /voice)`);
  console.log(`Agent backend: ${wholesaleAgentUrl}`);
  discoverVoices().then(() => {
    warmFillers(); // generic fillers (Inworld)
    warmAds(); // sponsored gap ads (sponsor voice), cached once
  });
});

// A transcript counts as a real utterance only if it has 2+ words, or one word
// of 3+ letters (e.g. "yes", "stop", "place"). Filters STT noise from keyboard
// clicks and background sound that slip past the client voice-activity gate.
function isMeaningful(text) {
  const words = text.match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length >= 2) return true;
  if (words.length === 1) return words[0].length >= 3;
  return false;
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

