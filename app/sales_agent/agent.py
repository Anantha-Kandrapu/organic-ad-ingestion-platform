from __future__ import annotations

import os

from langchain_core.messages import SystemMessage
from pydantic import BaseModel, Field

from .config import settings
from .tools import make_tools

SYSTEM_PROMPT = """You are Ada, a friendly and sharp wholesale sales agent for a \
grocery distributor. You talk with wholesale buyers (shop owners, grocers) over a \
text channel to help them find products, understand pricing and bulk offers, check \
stock, and place orders.

How to work:
- Use your tools to look up real product, offer, and stock data. Never invent SKUs, \
prices, or availability — always check.
- Read the customer's emotion and how satisfied they seem with an offer. If they \
sound hesitant or unhappy about a price, proactively use get_similar_offers or a \
bulk offer to find them a better deal.
- Guide them toward a good order: recommend the right bulk offer for their quantity, \
keep a running cart with update_cart, and use analyze_cost to show savings.
- Before placing an order, confirm the items and total with the customer. Only call \
place_order after they clearly agree.
- If something you need is missing (quantity, delivery preference, budget), use \
ask_user_question rather than guessing.
- Be concise, warm, and helpful. One or two short paragraphs per reply."""


def build_model():
    """Construct the chat model. Called per turn so the server can boot without a
    key; a missing key only fails when an actual turn runs."""
    from langchain_anthropic import ChatAnthropic

    if settings.anthropic_api_key:
        os.environ["ANTHROPIC_API_KEY"] = settings.anthropic_api_key

    return ChatAnthropic(
        model=settings.claude_model,
        max_tokens=settings.max_tokens,
        timeout=120,
        # Claude 5 models run adaptive thinking by default. In a tool-calling
        # react loop the thinking blocks must be replayed intact on every
        # follow-up call; the LangChain reconstruction drops them, which 400s
        # ("thinking.thinking: Field required"). We don't surface reasoning in a
        # sales agent, so disable thinking — simplest and fully reliable here.
        thinking={"type": "disabled"},
    )


def build_graph(conversation_id: int):
    from langgraph.prebuilt import create_react_agent

    model = build_model()
    tools = make_tools(conversation_id)
    return create_react_agent(model, tools)


def system_message() -> SystemMessage:
    return SystemMessage(content=SYSTEM_PROMPT)


# --- emotion / satisfaction estimation -----------------------------------------


class TurnAnalysis(BaseModel):
    emotion: str = Field(
        description="One word for the customer's dominant emotion this turn, e.g. "
        "happy, neutral, frustrated, hesitant, excited, annoyed."
    )
    satisfaction_score: float = Field(
        description="0.0 (very unsatisfied) to 1.0 (very satisfied) with the offer/"
        "conversation so far."
    )
    satisfaction_label: str = Field(
        description="One of: satisfied, neutral, unsatisfied."
    )


def analyze_turn(user_message: str, assistant_reply: str) -> TurnAnalysis | None:
    """Estimate the customer's emotion and satisfaction from the latest exchange."""
    try:
        model = build_model().with_structured_output(TurnAnalysis)
        prompt = (
            "Analyze this wholesale sales exchange and estimate the CUSTOMER's "
            "emotion and how satisfied they are.\n\n"
            f"Customer said: {user_message!r}\n"
            f"Sales agent replied: {assistant_reply!r}\n"
        )
        return model.invoke(prompt)
    except Exception:
        return None
