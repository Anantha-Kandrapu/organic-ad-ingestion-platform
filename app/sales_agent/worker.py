from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from . import redis_bus
from .agent import analyze_turn, build_graph, system_message
from .db import SessionLocal
from .models import Conversation, Message


def _text_from_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return ""


def _load_history(conversation_id: int):
    with SessionLocal() as db:
        rows = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.id.asc())
            .all()
        )
    history = []
    for row in rows:
        if row.role == "user":
            history.append(HumanMessage(content=row.content))
        else:
            history.append(AIMessage(content=row.content))
    return history


def _save_message(conversation_id: int, role: str, content: str) -> None:
    with SessionLocal() as db:
        db.add(Message(conversation_id=conversation_id, role=role, content=content))
        db.commit()


def run_turn(conversation_id: int, user_message: str) -> None:
    """Fully synchronous agent turn. Runs the LangGraph react agent, streaming
    tokens and tool activity to Redis, then persists results and analysis.
    Invoked via asyncio.to_thread so its blocking DB/model calls stay off the
    event loop."""
    cid = conversation_id
    try:
        _save_message(cid, "user", user_message)
        history = _load_history(cid)

        # Load any preferences learned on prior turns so the agent honors them.
        with SessionLocal() as db:
            conv = db.get(Conversation, cid)
            prior_pref = conv.offer_preference if conv else None

        graph = build_graph(cid)
        inputs = {"messages": [system_message(prior_pref)] + history}
        final_parts: list[str] = []

        for mode, data in graph.stream(inputs, stream_mode=["updates", "messages"]):
            if mode == "messages":
                chunk, meta = data
                if meta.get("langgraph_node") not in (None, "agent"):
                    continue
                text = _text_from_content(getattr(chunk, "content", ""))
                if text:
                    final_parts.append(text)
                    redis_bus.publish(cid, {"type": "token", "text": text})
            elif mode == "updates":
                for node, update in data.items():
                    for msg in update.get("messages", []) or []:
                        if isinstance(msg, ToolMessage):
                            redis_bus.publish(
                                cid,
                                {
                                    "type": "tool_result",
                                    "name": msg.name,
                                    "content": _text_from_content(msg.content),
                                },
                            )
                        elif isinstance(msg, AIMessage):
                            if msg.tool_calls:
                                # This agent step is calling tools, so any text it
                                # streamed was interim preamble — drop it so the
                                # stored/final message is only the last answer.
                                final_parts.clear()
                            for call in msg.tool_calls or []:
                                redis_bus.publish(
                                    cid,
                                    {
                                        "type": "tool_call",
                                        "name": call.get("name"),
                                        "args": call.get("args", {}),
                                    },
                                )

        final_text = "".join(final_parts).strip()
        if final_text:
            _save_message(cid, "assistant", final_text)
        redis_bus.publish(
            cid, {"type": "message", "role": "assistant", "content": final_text}
        )

        analysis = analyze_turn(user_message, final_text, prior_pref)
        if analysis is not None:
            new_pref = analysis.offer_preference.strip() or prior_pref
            with SessionLocal() as db:
                conv = db.get(Conversation, cid)
                if conv:
                    conv.emotion = analysis.emotion
                    conv.satisfaction_score = analysis.satisfaction_score
                    conv.satisfaction_label = analysis.satisfaction_label
                    conv.offer_preference = new_pref
                    db.commit()
            redis_bus.publish(
                cid,
                {
                    "type": "analysis",
                    "emotion": analysis.emotion,
                    "satisfaction_score": analysis.satisfaction_score,
                    "satisfaction_label": analysis.satisfaction_label,
                    "likes_offers": analysis.likes_offers,
                    "offer_preference": new_pref,
                },
            )

    except Exception as exc:  # surface failures to the SSE client
        redis_bus.publish(cid, {"type": "error", "message": str(exc)})
    finally:
        redis_bus.publish(cid, {"type": "done"})
