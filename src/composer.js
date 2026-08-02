export function composeDemoTurn({
  callSid,
  transcript,
  selection,
  turnId,
  llmText,
  llmSource = "inworld_llm_api",
  llmModel,
  llmSearchResults = [],
}) {
  const cleanTranscript = transcript?.trim();
  if (!cleanTranscript) throw new TypeError("transcript is required");
  if (!callSid?.trim()) throw new TypeError("callSid is required");

  const fallbackBefore = `I can help with that. I’ll focus on options matching “${truncate(cleanTranscript, 180)}.”`;
  const fallbackAfter = "Now I’ll continue with the regular product comparison.";
  const organicText = llmText?.trim() || `${fallbackBefore} ${fallbackAfter}`;
  const [beforeAd, afterAd] = llmText?.trim()
    ? splitForInjection(organicText)
    : [fallbackBefore, fallbackAfter];
  const llmResponse = {
    id: `llm_${turnId}`,
    type: "llm_response",
    source: llmText?.trim() ? llmSource : "demo_llm",
    model: llmModel || null,
    searchResults: llmSearchResults,
    text: organicText,
  };
  let injectedAd = null;
  let segments;

  if (selection?.eligible) {
    injectedAd = {
      id: `ad_${turnId}`,
      type: "injected_ad",
      source: "ad_engine",
      decisionId: `addec_${turnId}`,
      disclosure: selection.disclosure,
      text: selection.spokenCopy,
      product: selection.product,
      match: selection.match,
    };
    segments = [
      { ...llmResponse, id: `${llmResponse.id}:1`, parentId: llmResponse.id, text: beforeAd },
      injectedAd,
    ];
    if (afterAd) {
      segments.push({ ...llmResponse, id: `${llmResponse.id}:2`, parentId: llmResponse.id, text: afterAd });
    }
  } else {
    segments = [llmResponse];
  }

  return {
    type: "conversation_turn",
    turnId,
    callSid,
    input: { type: "caller_transcript", text: cleanTranscript },
    llmResponse,
    injectedAd,
    injection: {
      happened: segments.some((segment) => segment.type === "injected_ad"),
      segmentIndex: segments.findIndex((segment) => segment.type === "injected_ad"),
      reason: selection?.eligible ? "contextual_match" : selection?.reason || "no_match",
    },
    segments,
    composedResponse: {
      type: "composed_response",
      text: segments.map((segment) => segment.text).join(" "),
    },
  };
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit - 3).trimEnd()}...` : value;
}

function splitForInjection(value) {
  const sentenceEnd = value.search(/[.!?](?:\s|$)/);
  if (sentenceEnd < 0 || sentenceEnd + 1 >= value.length) return [value, ""];
  return [value.slice(0, sentenceEnd + 1).trim(), value.slice(sentenceEnd + 1).trim()];
}
