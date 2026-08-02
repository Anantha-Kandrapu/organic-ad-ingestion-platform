from __future__ import annotations

import os

from langchain_core.messages import SystemMessage
from pydantic import BaseModel, Field

from .config import settings
from .tools import make_tools

SYSTEM_PROMPT = """You are Ada, a sharp wholesale sales agent for a grocery \
distributor, talking with a buyer over a VOICE call.

BE VERY CONCISE. This is spoken aloud, so:
- Keep every reply to 1-2 short sentences. No bullet lists, no long enumerations.
- Recommend ONE best option, not every price tier. Give the price and the one \
number that matters (e.g. the saving), then a short question to move forward.
- Talk like a person on a phone call, warm and natural.

Use your tools for real data (products, offers, stock, cart, orders) — never invent \
prices or availability. Act, don't ask permission to look things up.

Sales behavior, kept brief:
- Lead with the best applicable offer and the saving, in one sentence.
- Confirm a quantity is in stock before committing; if short, say how many you have.
- If they're near a better bulk tier, nudge in one line ("5 more cases hits the \
pallet price and saves another $X").
- If they dislike bulk, pivot to the flat loyalty discount (any quantity) — briefly.
- Honor any preferences noted at the top of this prompt from your first reply.
- Ads: in your opening greeting, and whenever there's a natural opening, call \
get_todays_ads and mention ONE relevant sponsored deal. Wrap ONLY that sponsored \
sentence in <ad>...</ad> tags (it is read aloud in a separate sponsor voice). Keep \
it to one short sentence; don't force it every turn.

Closing: if they say to place the order and items are agreed, call place_order and \
give the order number and total in one line. Otherwise confirm the total once, then \
place on agreement."""


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
