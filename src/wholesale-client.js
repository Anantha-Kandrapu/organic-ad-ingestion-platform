export async function getWholesaleResponse({
  baseUrl,
  message,
  fetchImpl = fetch,
  timeoutMs = 12_000,
  pollIntervalMs = 250,
}) {
  if (!baseUrl?.trim()) throw new TypeError("Wholesale agent URL is required");
  if (!message?.trim()) throw new TypeError("Wholesale agent message is required");

  const deadline = Date.now() + timeoutMs;
  const startResponse = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/conversations/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: message.trim() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!startResponse.ok) throw new Error(`Wholesale agent start failed: HTTP ${startResponse.status}`);

  const { conversation_id: conversationId } = await startResponse.json();
  if (!Number.isInteger(conversationId)) throw new Error("Wholesale agent returned no conversation ID");

  while (Date.now() < deadline) {
    const response = await fetchImpl(
      `${baseUrl.replace(/\/$/, "")}/conversations/${conversationId}`,
      { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) },
    );
    if (!response.ok) throw new Error(`Wholesale agent poll failed: HTTP ${response.status}`);
    const conversation = await response.json();
    const assistantMessage = [...(conversation.messages || [])]
      .reverse()
      .find((entry) => entry.role === "assistant" && entry.content?.trim());
    if (assistantMessage) {
      return {
        text: assistantMessage.content.trim(),
        conversationId,
        source: "wholesale_agent",
      };
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  throw new Error(`Wholesale agent timed out after ${timeoutMs}ms`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
