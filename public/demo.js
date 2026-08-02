const micButton = document.querySelector("#mic");
const micLabel = micButton.querySelector("strong");
const micHint = micButton.querySelector("small");
const status = document.querySelector("#status");
const heard = document.querySelector("#heard");
const responsePanel = document.querySelector("#response");
const segments = document.querySelector("#segments");
const debugPanel = document.querySelector("#debug");
const json = document.querySelector("#json");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition;
let submitting = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  micButton.addEventListener("click", () => {
    recognition.start();
  });

  recognition.addEventListener("start", () => {
    submitting = false;
    heard.textContent = "";
    micButton.classList.add("listening");
    micLabel.textContent = "Listening";
    micHint.textContent = "Say what you need";
    status.textContent = "Listening...";
  });

  recognition.addEventListener("result", (event) => {
    const transcript = [...event.results]
      .map((result) => result[0].transcript)
      .join(" ")
      .trim();
    heard.textContent = transcript ? `“${transcript}”` : "";

    const finalResult = event.results[event.results.length - 1].isFinal;
    if (finalResult && !submitting) {
      submitting = true;
      runVoiceTurn(transcript);
    }
  });

  recognition.addEventListener("end", () => {
    micButton.classList.remove("listening");
    if (!submitting) resetButton();
  });

  recognition.addEventListener("error", (event) => {
    submitting = false;
    micButton.classList.remove("listening");
    resetButton();
    status.textContent = event.error === "not-allowed"
      ? "Allow microphone access in the browser, then tap again."
      : `Could not hear you: ${event.error}. Tap to try again.`;
  });
} else {
  micButton.disabled = true;
  micLabel.textContent = "Voice unavailable";
  micHint.textContent = "Use a browser with speech recognition";
  status.textContent = "This browser does not support voice input.";
}

async function runVoiceTurn(transcript) {
  if (!transcript) {
    submitting = false;
    resetButton();
    status.textContent = "I did not hear anything. Tap and try again.";
    return;
  }

  micButton.disabled = true;
  micButton.classList.add("thinking");
  micLabel.textContent = "Thinking";
  micHint.textContent = "Preparing your answer";
  status.textContent = "Finding the best response...";
  responsePanel.hidden = true;
  debugPanel.hidden = true;
  segments.replaceChildren();

  try {
    const callSid = `VOICE-${Date.now()}`;
    const sponsorRequest = postJson("/api/demo/sponsor", { callSid });
    const agentRequest = postJson("/api/demo/turn", {
      callSid,
      transcript,
      suppressAd: true,
    });

    const sponsorBreak = await sponsorRequest;
    renderSegments(sponsorBreak.segments);
    responsePanel.hidden = false;
    const timeline = [{ event: "llm_request_started", at: new Date().toISOString() }];
    json.textContent = JSON.stringify({ sponsorBreak, agentTurn: "running_in_parallel", timeline }, null, 2);
    debugPanel.hidden = false;
    status.textContent = "LLM request running in parallel · generating sponsored audio";
    const sponsorAudio = await requestTts(sponsorBreak.injectedAd.text, "sponsor");
    timeline.push({ event: "sponsor_tts_ready", provider: "inworld", at: new Date().toISOString() });
    status.textContent = "LLM request running in parallel · sponsored message playing";
    await playAudio(sponsorAudio);
    timeline.push({ event: "sponsor_finished", at: new Date().toISOString() });

    const agentTurn = await agentRequest;
    renderSegments(agentTurn.segments);
    status.textContent = "Results ready · generating agent audio with Inworld";
    const agentText = agentTurn.segments.map((segment) => segment.text).join(" ");
    const agentAudio = await requestTts(agentText, "agent");
    timeline.push({ event: "agent_tts_ready", provider: "inworld", at: new Date().toISOString() });
    const result = {
      type: "voice_llm_with_sponsor",
      input: { type: "caller_transcript", text: transcript },
      sponsorBreak,
      agentTurn,
      tts: {
        provider: "inworld",
        calls: [
          { role: "sponsor", voice: sponsorAudio.voice, model: sponsorAudio.model },
          { role: "agent", voice: agentAudio.voice, model: agentAudio.model },
        ],
      },
      timeline,
    };
    json.textContent = JSON.stringify(result, null, 2);
    status.textContent = "LLM response ready · assistant audio playing";
    await playAudio(agentAudio);
    timeline.push({ event: "agent_response_finished", at: new Date().toISOString() });
    json.textContent = JSON.stringify(result, null, 2);
    status.textContent = "Finished. Tap to ask something else.";
  } catch (error) {
    status.textContent = `Something went wrong: ${error.message}. Tap to try again.`;
    json.textContent = JSON.stringify({ error: error.message }, null, 2);
    debugPanel.hidden = false;
  } finally {
    submitting = false;
    micButton.disabled = false;
    micButton.classList.remove("thinking");
    resetButton();
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function renderSegments(items) {
  items.forEach((segment, index) => {
    const element = document.createElement("article");
    element.className = `segment ${segment.type}`;
    element.style.animationDelay = `${index * 100}ms`;

    const label = document.createElement("span");
    label.className = "segment-label";
    label.textContent = segment.type === "injected_ad" ? "Sponsored ad" : "Assistant";

    const copy = document.createElement("p");
    copy.textContent = segment.text;
    element.append(label, copy);
    segments.append(element);
  });
}

async function requestTts(text, role) {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, role }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `TTS HTTP ${response.status}`);
  }
  return {
    url: URL.createObjectURL(await response.blob()),
    provider: response.headers.get("X-TTS-Provider"),
    model: response.headers.get("X-TTS-Model"),
    voice: response.headers.get("X-TTS-Voice"),
  };
}

function playAudio(audioAsset) {
  const audio = new Audio(audioAsset.url);
  return new Promise((resolve, reject) => {
    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(audioAsset.url);
      resolve();
    }, { once: true });
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(audioAsset.url);
      reject(new Error("Generated audio could not be played"));
    }, { once: true });
    audio.play().catch(reject);
  });
}

function resetButton() {
  micLabel.textContent = "Start talking";
  micHint.textContent = "Tap to use microphone";
}
