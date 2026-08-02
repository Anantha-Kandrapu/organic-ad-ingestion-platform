// Continuous browser voice loop:
// mic -> downsample to 16 kHz LINEAR16 -> WS -> Inworld STT -> agent -> TTS -> play -> listen again.

const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const partialEl = document.getElementById("partial");
const logEl = document.getElementById("log");
const timerEl = document.getElementById("timer");
const meterEl = document.getElementById("meter");
const meterMarkEl = document.getElementById("meterMark");

// Live mic meter: fill = current level; the tick = the gate threshold.
// Bar turns green when the level clears the gate (treated as speech).
function updateMeter(level, threshold) {
  if (!meterEl) return;
  meterEl.style.width = Math.min(100, (level / METER_SCALE) * 100) + "%";
  meterEl.style.background = level > threshold ? "#5be389" : "#3f5877";
  if (meterMarkEl) {
    meterMarkEl.style.left = Math.min(100, (threshold / METER_SCALE) * 100) + "%";
  }
}

let timerId = null;
let callStart = 0;
function startTimer() {
  if (timerId) return;
  callStart = Date.now();
  timerEl.textContent = "00:00";
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - callStart) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    timerEl.textContent = `${mm}:${ss}`;
  }, 500);
}
function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  timerEl.textContent = "Ready to call";
}

let ws = null;
let audioContext = null;
let mediaStream = null;
let processor = null;
let sourceNode = null;
let running = false;
let clientState = "listening"; // mirrors server state: listening | thinking | speaking
let currentAudio = null; // in-flight TTS playback
let currentAudioUrl = null;
let replyQueue = []; // pending reply audio segments, played in order
let awaitingReply = false; // a real (non-filler) reply is playing/queued

// --- Voice-activity gate ---
// We only stream audio when there's real speech, so background noise and
// keyboard clicks never reach the STT. Onset requires several sustained loud
// frames (a click is a single transient and won't qualify); a short hangover
// keeps streaming after speech so the STT can detect end-of-utterance.
// Continuous listening: mic audio streams the whole time and Inworld's own
// speech detection finds utterance boundaries. The only gate is while the agent
// is speaking — forward audio only if it's loud enough to be a real
// interruption (barge-in), so the agent's own voice isn't transcribed back.
const BARGE_RMS = 0.05; // loudness needed to talk over the agent (barge-in)
const METER_SCALE = 0.12; // full meter bar at this RMS

function setStatus(state, label) {
  document.body.dataset.state = state;
  statusEl.textContent = label || state;
}

function addTurn(who, text, meta) {
  const div = document.createElement("div");
  div.className = `turn ${who}`;
  const label = document.createElement("div");
  label.className = "who";
  label.textContent = who === "user" ? "You" : "Ada";
  const body = document.createElement("div");
  body.textContent = text;
  div.append(label, body);
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    div.append(m);
  }
  logEl.append(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
}

toggle.addEventListener("click", () => (running ? stop() : start()));

async function start() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true, // suppresses keyboard/background before it hits us
        autoGainControl: true, // normalize speech loudness; adaptive gate handles the rest
      },
    });
  } catch (error) {
    setStatus("error", "Mic access denied");
    return;
  }

  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsProtocol}://${location.host}/voice/media`);
  ws.addEventListener("open", startTimer);
  ws.addEventListener("message", onServerMessage);
  ws.addEventListener("close", () => running && stop());
  ws.addEventListener("error", () => setStatus("error", "Connection error"));

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(processor);
  processor.connect(audioContext.destination);

  const srcRate = audioContext.sampleRate;
  processor.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    updateMeter(rms(input), BARGE_RMS);
    // Turn-based: the mic is muted while the agent is thinking or speaking.
    if (clientState !== "listening") return;
    ws.send(JSON.stringify({ type: "audio", data: encodeFrame(input, srcRate) }));
  };

  running = true;
  toggle.classList.replace("call", "end");
  toggle.setAttribute("aria-label", "End call");
  timerEl.textContent = "Calling…";
  setStatus("listening", "Listening…");
}

function stop() {
  running = false;
  stopPlayback();
  awaitingReply = false;
  replyQueue = [];
  stopTimer();
  toggle.classList.replace("end", "call");
  toggle.setAttribute("aria-label", "Call");
  setStatus("idle", "Idle");
  if (meterEl) meterEl.style.width = "0%";
  processor?.disconnect();
  sourceNode?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  ws?.close();
  ws = processor = sourceNode = mediaStream = audioContext = null;
}

function onServerMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  switch (message.type) {
    case "status":
      clientState = message.state;
      if (message.state === "listening") setStatus("listening", "Listening…");
      else if (message.state === "thinking") setStatus("thinking", "Thinking…");
      else if (message.state === "speaking") setStatus("speaking", "Speaking…");
      break;
    case "partial_transcript":
      partialEl.textContent = message.text;
      break;
    case "user_transcript":
      partialEl.textContent = "";
      addTurn("user", message.text);
      break;
    case "agent_text": {
      const meta = [
        message.emotion ? `emotion: ${message.emotion}` : null,
        message.satisfaction != null ? `satisfaction: ${message.satisfaction}` : null,
      ].filter(Boolean).join(" · ");
      addTurn("agent", message.text, meta || null);
      break;
    }
    case "agent_audio":
      handleAgentAudio(message);
      break;
    case "error":
      setStatus("error", message.message?.slice(0, 60) || "Error");
      break;
  }
}

function handleAgentAudio(message) {
  if (message.filler) {
    // Play a filler only if no real reply is already playing/queued.
    if (!awaitingReply && !currentAudio) startClip(message.data, { filler: true });
    return;
  }
  // Real reply segment. The first one cuts any filler and starts the queue.
  if (!awaitingReply) {
    awaitingReply = true;
    stopPlayback();
    replyQueue = [];
  }
  replyQueue.push({ data: message.data, final: message.final === true });
  if (!currentAudio) pumpQueue();
}

function pumpQueue() {
  const item = replyQueue.shift();
  if (item) startClip(item.data, { final: item.final });
}

function startClip(base64Wav, opts) {
  stopPlayback();
  const bytes = base64ToBytes(base64Wav);
  const blob = new Blob([bytes], { type: "audio/wav" });
  currentAudioUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(currentAudioUrl);
  const onEnd = () => {
    cleanupAudio();
    if (opts.filler) return;
    if (replyQueue.length) {
      pumpQueue();
    } else if (opts.final) {
      awaitingReply = false;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "playback_done" }));
    }
    // non-final with empty queue: wait; the next segment will pump on arrival.
  };
  currentAudio.addEventListener("ended", onEnd);
  currentAudio.play().catch(onEnd);
}

// Stop playback immediately (barge-in) without signalling a natural finish.
function stopPlayback() {
  if (currentAudio) currentAudio.pause();
  cleanupAudio();
}

function cleanupAudio() {
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  currentAudio = null;
}

function rms(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i += 1) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

function encodeFrame(float32, srcRate) {
  return int16ToBase64(floatToInt16(downsampleTo16k(float32, srcRate)));
}

// --- audio helpers -------------------------------------------------------------

function downsampleTo16k(float32, srcRate) {
  if (srcRate === 16000) return float32;
  const ratio = srcRate / 16000;
  const newLength = Math.floor(float32.length / ratio);
  const result = new Float32Array(newLength);
  let offsetOut = 0;
  let offsetIn = 0;
  while (offsetOut < newLength) {
    const nextIn = Math.floor((offsetOut + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = offsetIn; i < nextIn && i < float32.length; i += 1) {
      sum += float32[i];
      count += 1;
    }
    result[offsetOut] = count > 0 ? sum / count : 0;
    offsetOut += 1;
    offsetIn = nextIn;
  }
  return result;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
