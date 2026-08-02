/**
 * Multi-turn client for the FastAPI wholesale sales agent.
 *
 * A voice conversation is one agent conversation: we `start` once, then
 * `continue` for every following utterance, so the agent keeps its cart,
 * sentiment, and learned preferences across turns. After each turn we poll the
 * conversation until a NEW assistant message appears, and return its text for
 * text-to-speech.
 */
export async function sendToAgent({
  baseUrl,
  conversationId = null,
  priorAssistantCount = 0,
  message,
  customerId = 1,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  pollIntervalMs = 300,
}) {
  if (!baseUrl?.trim()) throw new TypeError("Agent base URL is required");
  if (!message?.trim()) throw new TypeError("Agent message is required");
  const base = baseUrl.replace(/\/$/, "");
  const deadline = Date.now() + timeoutMs;

  if (conversationId == null) {
    const started = await postJson(fetchImpl, `${base}/conversations/start`, {
      customer_id: customerId,
      message: message.trim(),
    }, timeoutMs);
    conversationId = started.conversation_id;
    if (!Number.isInteger(conversationId)) {
      throw new Error("Agent returned no conversation id");
    }
  } else {
    await postJson(fetchImpl, `${base}/conversations/${conversationId}/continue`, {
      message: message.trim(),
    }, timeoutMs);
  }

  while (Date.now() < deadline) {
    const conversation = await getJson(
      fetchImpl,
      `${base}/conversations/${conversationId}`,
      Math.max(1, deadline - Date.now()),
    );
    const assistantMessages = (conversation.messages || []).filter(
      (entry) => entry.role === "assistant" && entry.content?.trim(),
    );
    if (assistantMessages.length > priorAssistantCount) {
      return {
        conversationId,
        assistantCount: assistantMessages.length,
        text: assistantMessages[assistantMessages.length - 1].content.trim(),
        emotion: conversation.emotion,
        satisfaction: conversation.satisfaction_score,
        offerPreference: conversation.offer_preference,
      };
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  throw new Error(`Agent timed out after ${timeoutMs}ms`);
}

async function postJson(fetchImpl, url, body, timeoutMs) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function getJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
