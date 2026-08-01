from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import redis_bus
from .config import settings
from .db import SessionLocal, init_db
from .models import (
    Cart,
    CartItem,
    Conversation,
    Customer,
    Message,
    Product,
)
from .schemas import (
    ContinueRequest,
    ContinueResponse,
    StartRequest,
    StartResponse,
)
from .worker import run_turn

# Keep references to fire-and-forget turn tasks so they aren't garbage collected.
_bg_tasks: set[asyncio.Task] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Wholesale Sales Agent", lifespan=lifespan)


def _schedule_turn(conversation_id: int, message: str) -> None:
    task = asyncio.create_task(asyncio.to_thread(run_turn, conversation_id, message))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": settings.claude_model, "has_key": bool(settings.anthropic_api_key)}


@app.post("/conversations/start", response_model=StartResponse)
async def start(req: StartRequest) -> StartResponse:
    with SessionLocal() as db:
        if req.customer_id is not None and db.get(Customer, req.customer_id) is None:
            raise HTTPException(404, f"customer {req.customer_id} not found")
        conv = Conversation(customer_id=req.customer_id, status="open")
        db.add(conv)
        db.flush()
        # Pre-create the active cart so concurrent update_cart tool calls on the
        # first turn never race to create duplicate carts.
        db.add(Cart(conversation_id=conv.id, status="active"))
        db.commit()
        conv_id = conv.id

    if req.message:
        _schedule_turn(conv_id, req.message)
    return StartResponse(conversation_id=conv_id, status="open")


@app.post("/conversations/{conversation_id}/continue", response_model=ContinueResponse)
async def continue_conversation(
    conversation_id: int, req: ContinueRequest
) -> ContinueResponse:
    with SessionLocal() as db:
        if db.get(Conversation, conversation_id) is None:
            raise HTTPException(404, f"conversation {conversation_id} not found")
    _schedule_turn(conversation_id, req.message)
    return ContinueResponse(conversation_id=conversation_id, status="processing")


@app.get("/conversations/{conversation_id}/events")
async def events(conversation_id: int, request: Request) -> StreamingResponse:
    with SessionLocal() as db:
        if db.get(Conversation, conversation_id) is None:
            raise HTTPException(404, f"conversation {conversation_id} not found")

    async def event_stream():
        async for event in redis_bus.subscribe(conversation_id):
            if await request.is_disconnected():
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: int) -> dict:
    with SessionLocal() as db:
        conv = db.get(Conversation, conversation_id)
        if conv is None:
            raise HTTPException(404, f"conversation {conversation_id} not found")
        messages = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.id.asc())
            .all()
        )
        cart = (
            db.query(Cart)
            .filter(Cart.conversation_id == conversation_id, Cart.status == "active")
            .first()
        )
        cart_items = []
        cart_total = 0.0
        if cart:
            for it in db.query(CartItem).filter(CartItem.cart_id == cart.id):
                product = db.get(Product, it.product_id)
                cart_total += float(it.line_total)
                cart_items.append(
                    {
                        "product": product.name if product else it.product_id,
                        "quantity": it.quantity,
                        "unit_price": float(it.unit_price),
                        "line_total": float(it.line_total),
                    }
                )
        return {
            "conversation_id": conv.id,
            "customer_id": conv.customer_id,
            "status": conv.status,
            "emotion": conv.emotion,
            "satisfaction_score": float(conv.satisfaction_score)
            if conv.satisfaction_score is not None
            else None,
            "satisfaction_label": conv.satisfaction_label,
            "offer_preference": conv.offer_preference,
            "messages": [
                {"role": m.role, "content": m.content, "at": m.created_at.isoformat()}
                for m in messages
            ],
            "cart": {"items": cart_items, "total": round(cart_total, 2)},
        }


@app.get("/products")
def list_products() -> list[dict]:
    with SessionLocal() as db:
        rows = db.query(Product).order_by(Product.id.asc()).all()
        return [
            {
                "product_id": p.id,
                "sku": p.sku,
                "name": p.name,
                "category": p.category,
                "unit": p.unit,
                "base_price": float(p.base_price),
            }
            for p in rows
        ]


@app.get("/customers")
def list_customers() -> list[dict]:
    with SessionLocal() as db:
        rows = db.query(Customer).order_by(Customer.id.asc()).all()
        return [
            {"customer_id": c.id, "name": c.name, "company": c.company}
            for c in rows
        ]
