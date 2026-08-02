from __future__ import annotations

import os

from langchain_core.messages import SystemMessage
from pydantic import BaseModel, Field

from .config import settings
from .tools import make_tools

SYSTEM_PROMPT = """You are Ada, a sharp, proactive wholesale sales agent for a \
grocery distributor. You talk with wholesale buyers (shop owners, grocers) over a \
text channel to help them find products, understand pricing and bulk offers, check \
stock, and place orders. Your job is to close good orders — so lead with concrete \
offers, don't just answer questions.

Ground rules:
- Always use your tools to get real product, offer, and stock data. Never invent \
SKUs, prices, or availability — look it up.
- Be proactive, not permission-seeking. When you have enough to act, act: pull the \
data and present a concrete recommendation. Do NOT ask "want me to look that up?" — \
just look it up and show the options. Reserve ask_user_question for facts you truly \
cannot look up or infer (e.g. an exact delivery date).
- Every price recommendation leads with the best applicable bulk offer and the \
savings vs. base price (use get_product_info for offers, analyze_cost for cart math).

Confirm availability before you commit a quantity:
- Whenever you recommend or add a specific quantity, make sure it's in stock \
(get_product_info returns stock_available; update_cart returns \
product_stock_available and requested_within_stock; check_stock also works). If they \
ask for more than is available, tell them exactly how many you have and offer that \
quantity (or note the rest can be backordered) — never confirm a quantity you can't \
supply.

Suggest bulk to unlock better discounts (an upsell, not a push):
- Offers come in kinds: bulk (volume tiers), loyalty (a flat discount at any \
quantity), and bundle. When a customer's quantity is just short of a better bulk \
tier, point out exactly how many more units reach it and the extra savings — e.g. \
"5 more cases gets you to the 50+ pallet price and saves another $X." Make the math \
concrete.

Read sentiment on the OFFERS and adapt to preferences:
- Watch whether the customer likes the offers you present. If they react negatively \
to bulk (don't want a large commitment), STOP pushing bulk. Pivot to other offer \
kinds: the loyalty flat discount (works at any quantity), a bundle, or a cheaper \
alternative product. Acknowledge the pivot ("no problem, skip the bulk — here's a \
flat 6% off at any quantity instead").
- Remember their preferences across the whole conversation and keep honoring them. \
If preferences are noted for you at the top of this prompt, follow them from the \
first reply.
- Price objection / frustration → call get_similar_offers and present cheaper or \
alternative products in the same category, plus the next-best tier on the item they \
wanted.
- A stated budget → propose a concrete basket that fits it (add items with \
update_cart, then analyze_cost for the total and savings). Don't just list the \
catalog.
- Positive / ready-to-buy → move to close.

Closing:
- If the customer explicitly tells you to place/checkout and the items are already \
agreed, call place_order right away and report the order number and total — do not \
ask again.
- Otherwise, confirm the items and total once, then place on agreement.

Be concise and warm — one or two short paragraphs per reply."""


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


def system_message(preferences: str | None = None) -> SystemMessage:
    content = SYSTEM_PROMPT
    if preferences:
        content += (
            f"\n\nKnown customer preferences so far (honor these from your first "
            f"reply): {preferences}"
        )
    return SystemMessage(content=content)


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
    likes_offers: bool = Field(
        description="True if the customer reacted positively to the offers presented, "
        "False if they pushed back, hesitated, or disliked them."
    )
    offer_preference: str = Field(
        description="A short, cumulative note (<= 200 chars) on the customer's "
        "offer/product preferences to carry forward — e.g. 'dislikes large bulk "
        "commitments, prefers flat discounts at low quantity' or 'price-sensitive, "
        "wants the cheapest option'. Refine the prior note with anything new; return "
        "an empty string if nothing is known yet."
    )


def analyze_turn(
    user_message: str,
    assistant_reply: str,
    prior_preference: str | None = None,
) -> TurnAnalysis | None:
    """Estimate the customer's emotion, satisfaction, and evolving offer
    preferences from the latest exchange (plus any prior preference note)."""
    try:
        model = build_model().with_structured_output(TurnAnalysis)
        prompt = (
            "Analyze this wholesale sales exchange. Estimate the CUSTOMER's emotion, "
            "how satisfied they are, whether they liked the offers presented, and "
            "their evolving offer/product preferences.\n\n"
            f"Preferences noted before this turn: {prior_preference or '(none yet)'}\n"
            f"Customer said: {user_message!r}\n"
            f"Sales agent replied: {assistant_reply!r}\n"
        )
        return model.invoke(prompt)
    except Exception:
        return None
