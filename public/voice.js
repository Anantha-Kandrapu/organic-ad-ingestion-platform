// Continuous browser voice loop:
// mic -> downsample to 16 kHz LINEAR16 -> WS -> Inworld STT -> agent -> TTS -> play -> listen again.

const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const partialEl = document.getElementById("partial");
const logEl = document.getElementById("log");

let ws = null;
let audioContext = null;
let mediaStream = null;
let processor = null;
let sourceNode = null;
let running = false;
let speaking = false; // muting mic while the agent talks (avoids echo/self-capture)

function setStatus(state, label) {
  statusEl.className = `status ${state}`;
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
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    setStatus("error", "Mic access denied");
    return;
  }

  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsProtocol}://${location.host}/voice/media`);
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
    if (!ws || ws.readyState !== WebSocket.OPEN || speaking) return;
    const input = event.inputBuffer.getChannelData(0);
    const down = downsampleTo16k(input, srcRate);
    const pcm16 = floatToInt16(down);
    ws.send(JSON.stringify({ type: "audio", data: int16ToBase64(pcm16) }));
  };

  running = true;
  toggle.textContent = "Stop";
  toggle.classList.add("stop");
  setStatus("listening", "Listening…");
}

function stop() {
  running = false;
  speaking = false;
  toggle.textContent = "Start talking";
  toggle.classList.remove("stop");
  setStatus("idle", "Idle");
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
      playAgentAudio(message.data);
      break;
    case "error":
      setStatus("error", message.message?.slice(0, 60) || "Error");
      break;
  }
}

function playAgentAudio(base64Wav) {
  speaking = true;
  const bytes = base64ToBytes(base64Wav);
  const blob = new Blob([bytes], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.addEventListener("ended", () => {
    URL.revokeObjectURL(url);
    speaking = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "playback_done" }));
  });
  audio.play().catch(() => {
    speaking = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "playback_done" }));
  });
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
