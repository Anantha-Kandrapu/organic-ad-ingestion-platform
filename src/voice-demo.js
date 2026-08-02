const NUMBER_WORDS = new Map([
  ["five", 5], ["ten", 10], ["fifteen", 15], ["twenty", 20], ["twenty five", 25],
  ["thirty", 30], ["forty", 40], ["fifty", 50], ["seventy five", 75],
  ["one hundred", 100], ["hundred", 100],
]);

export function buildGatherTwiML({ actionUrl }) {
  return xmlResponse(
    `<Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" `
      + `speechTimeout="auto" actionOnEmptyResult="true">`
      + "<Say>Welcome to The Break ad injection demo. Tell me what product you are shopping for, including your budget.</Say>"
      + "</Gather>"
      + "<Say>I did not hear a request. Please call again.</Say>",
  );
}

export function buildSpokenTurnTwiML(turn) {
  const spokenSegments = turn.segments.map((segment) => {
    const pause = segment.type === "injected_ad" ? '<Pause length="1"/>' : "";
    return `${pause}<Say>${escapeXml(segment.text)}</Say>${pause}`;
  }).join("");

  return xmlResponse(`${spokenSegments}<Say>That completes the injection demo. Goodbye.</Say><Hangup/>`);
}

export function buildRetryTwiML({ voiceUrl }) {
  return xmlResponse(
    "<Say>I did not hear a shopping request. Let us try once more.</Say>"
      + `<Redirect method="POST">${escapeXml(voiceUrl)}</Redirect>`,
  );
}

export function parseSpokenBudget(transcript) {
  const normalized = transcript.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
  const numeric = normalized.match(/\b(?:under|below|less than|up to|maximum|max)\s+\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (numeric) return Number(numeric[1]);

  for (const [words, value] of NUMBER_WORDS) {
    if (new RegExp(`\\b(?:under|below|less than|up to|maximum|max)\\s+${words}\\b`).test(normalized)) {
      return value;
    }
  }
  return undefined;
}

function xmlResponse(contents) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${contents}</Response>`;
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
