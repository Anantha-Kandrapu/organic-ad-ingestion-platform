/**
 * Multi-turn client for the FastAPI wholesale sales agent.
 *
 * A voice conversation is one agent conversation: we `start` once, then
 * `continue` for every following utterance, so the agent keeps its cart,
 * sentiment, and learned preferences across turns.
 *
 * `signal` lets a caller cancel an in-flight turn (used for barge-in). When
 * continuing, we re-read the current assistant-message count fresh so a
 * previously-cancelled turn whose reply landed late can't desync us — we always
 * wait for the NEXT reply and return the most recent assistant message.
 */
export async function sendToAgent({
  baseUrl,
  conversationId = null,
  message,
  customerId = 1,
  signal,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  pollIntervalMs = 300,
}) {
  if (!baseUrl?.trim()) throw new TypeError("Agent base URL is required");
  if (!message?.trim()) throw new TypeError("Agent message is required");
  const base = baseUrl.replace(/\/$/, "");
  const deadline = Date.now() + timeoutMs;

  let baseline = 0;
  if (conversationId == null) {
    const started = await postJson(fetchImpl, `${base}/conversations/start`, {
      customer_id: customerId,
      message: message.trim(),
    }, timeoutMs, signal);
    conversationId = started.conversation_id;
    if (!Number.isInteger(conversationId)) throw new Error("Agent returned no conversation id");
  } else {
    // Fresh baseline: count assistant messages that already exist right now.
    const current = await getJson(fetchImpl, `${base}/conversations/${conversationId}`, timeoutMs, signal);
    baseline = countAssistant(current);
    await postJson(fetchImpl, `${base}/conversations/${conversationId}/continue`, {
      message: message.trim(),
    }, timeoutMs, signal);
  }

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const conversation = await getJson(
      fetchImpl,
      `${base}/conversations/${conversationId}`,
      Math.max(1, deadline - Date.now()),
      signal,
    );
    const assistant = (conversation.messages || []).filter(
      (entry) => entry.role === "assistant" && entry.content?.trim(),
    );
    if (assistant.length > baseline) {
      return {
        conversationId,
        text: assistant[assistant.length - 1].content.trim(),
        emotion: conversation.emotion,
        satisfaction: conversation.satisfaction_score,
        offerPreference: conversation.offer_preference,
      };
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  throw new Error(`Agent timed out after ${timeoutMs}ms`);
}

function countAssistant(conversation) {
  return (conversation.messages || []).filter(
    (entry) => entry.role === "assistant" && entry.content?.trim(),
  ).length;
}

function combineSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postJson(fetchImpl, url, body, timeoutMs, signal) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: combineSignal(timeoutMs, signal),
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function getJson(fetchImpl, url, timeoutMs, signal) {
  const response = await fetchImpl(url, { signal: combineSignal(timeoutMs, signal) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
