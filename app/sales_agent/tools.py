from __future__ import annotations

import json
from typing import Optional

from langchain_core.tools import tool
from sqlalchemy import select

from .db import SessionLocal
from .models import (
    Cart,
    CartItem,
    Inventory,
    Offer,
    Order,
    OrderItem,
    Product,
)


def _dump(obj) -> str:
    return json.dumps(obj, default=str)


def _get_active_cart(db, conversation_id: int) -> Cart:
    cart = (
        db.query(Cart)
        .filter(Cart.conversation_id == conversation_id, Cart.status == "active")
        .order_by(Cart.id.asc())
        .first()
    )
    if cart is None:
        cart = Cart(conversation_id=conversation_id, status="active")
        db.add(cart)
        db.flush()
    return cart


def _cart_state(db, cart: Cart) -> dict:
    items = db.query(CartItem).filter(CartItem.cart_id == cart.id).all()
    lines = []
    total = 0.0
    for it in items:
        product = db.get(Product, it.product_id)
        line_total = float(it.line_total)
        total += line_total
        lines.append(
            {
                "product_id": it.product_id,
                "product": product.name if product else None,
                "offer_id": it.offer_id,
                "quantity": it.quantity,
                "unit_price": float(it.unit_price),
                "line_total": line_total,
            }
        )
    return {"cart_id": cart.id, "items": lines, "total": round(total, 2)}


def make_tools(conversation_id: int) -> list:
    """Build the agent's tool set, bound to one conversation's cart."""

    @tool
    def get_products(category: Optional[str] = None, search: Optional[str] = None) -> str:
        """List available wholesale products. Optionally filter by category
        (Beverages, Snacks, Dairy, Grains) or a text search on the product name."""
        with SessionLocal() as db:
            stmt = select(Product)
            if category:
                stmt = stmt.where(Product.category.ilike(f"%{category}%"))
            if search:
                stmt = stmt.where(Product.name.ilike(f"%{search}%"))
            rows = db.execute(stmt).scalars().all()
            return _dump(
                [
                    {
                        "product_id": p.id,
                        "sku": p.sku,
                        "name": p.name,
                        "category": p.category,
                        "unit": p.unit,
                        "base_price": float(p.base_price),
                        "currency": p.currency,
                    }
                    for p in rows
                ]
            )

    @tool
    def get_product_info(product_id: int) -> str:
        """Get full detail for one product: description, base price, all offers,
        and current stock."""
        with SessionLocal() as db:
            p = db.get(Product, product_id)
            if not p:
                return _dump({"error": f"product {product_id} not found"})
            offers = db.query(Offer).filter(Offer.product_id == product_id).all()
            stock = sum(
                inv.quantity_available
                for inv in db.query(Inventory).filter(
                    Inventory.product_id == product_id
                )
            )
            return _dump(
                {
                    "product_id": p.id,
                    "sku": p.sku,
                    "name": p.name,
                    "description": p.description,
                    "category": p.category,
                    "unit": p.unit,
                    "base_price": float(p.base_price),
                    "currency": p.currency,
                    "stock_available": stock,
                    "offers": [
                        {
                            "offer_id": o.id,
                            "name": o.name,
                            "kind": o.kind,
                            "min_quantity": o.min_quantity,
                            "unit_price": float(o.unit_price),
                            "discount_pct": float(o.discount_pct),
                            "valid_until": o.valid_until,
                        }
                        for o in offers
                    ],
                }
            )

    @tool
    def get_offer(offer_id: int) -> str:
        """Get detail for a single offer by its offer_id."""
        with SessionLocal() as db:
            o = db.get(Offer, offer_id)
            if not o:
                return _dump({"error": f"offer {offer_id} not found"})
            return _dump(
                {
                    "offer_id": o.id,
                    "product_id": o.product_id,
                    "name": o.name,
                    "kind": o.kind,
                    "min_quantity": o.min_quantity,
                    "unit_price": float(o.unit_price),
                    "discount_pct": float(o.discount_pct),
                    "valid_until": o.valid_until,
                }
            )

    @tool
    def get_similar_offers(product_id: int) -> str:
        """Find alternative offers on products in the same category as the given
        product. Useful when a customer is unhappy with a price or wants options."""
        with SessionLocal() as db:
            p = db.get(Product, product_id)
            if not p:
                return _dump({"error": f"product {product_id} not found"})
            peers = (
                db.query(Product)
                .filter(Product.category == p.category, Product.id != product_id)
                .all()
            )
            result = []
            for peer in peers:
                offers = db.query(Offer).filter(Offer.product_id == peer.id).all()
                result.append(
                    {
                        "product_id": peer.id,
                        "name": peer.name,
                        "base_price": float(peer.base_price),
                        "offers": [
                            {
                                "offer_id": o.id,
                                "name": o.name,
                                "kind": o.kind,
                                "min_quantity": o.min_quantity,
                                "unit_price": float(o.unit_price),
                                "discount_pct": float(o.discount_pct),
                            }
                            for o in offers
                        ],
                    }
                )
            return _dump({"category": p.category, "alternatives": result})

    @tool
    def check_stock(product_id: int) -> str:
        """Check available stock for a product across warehouses."""
        with SessionLocal() as db:
            rows = db.query(Inventory).filter(Inventory.product_id == product_id).all()
            if not rows:
                return _dump({"product_id": product_id, "stock_available": 0})
            return _dump(
                {
                    "product_id": product_id,
                    "stock_available": sum(r.quantity_available for r in rows),
                    "by_warehouse": [
                        {"warehouse": r.warehouse, "quantity": r.quantity_available}
                        for r in rows
                    ],
                }
            )

    @tool
    def update_cart(
        product_id: int,
        quantity: int,
        offer_id: Optional[int] = None,
        action: str = "add",
    ) -> str:
        """Add, set, or remove a product in the customer's cart.
        action is 'add' (increase quantity), 'set' (set exact quantity), or
        'remove' (drop the line). Pass offer_id to apply an offer's unit price;
        otherwise the base price is used."""
        action = action.lower()
        with SessionLocal() as db:
            product = db.get(Product, product_id)
            if not product:
                return _dump({"error": f"product {product_id} not found"})

            unit_price = float(product.base_price)
            if offer_id is not None:
                offer = db.get(Offer, offer_id)
                if not offer or offer.product_id != product_id:
                    return _dump({"error": f"offer {offer_id} invalid for this product"})
                unit_price = float(offer.unit_price)

            cart = _get_active_cart(db, conversation_id)
            item = (
                db.query(CartItem)
                .filter(CartItem.cart_id == cart.id, CartItem.product_id == product_id)
                .first()
            )

            if action == "remove":
                if item:
                    db.delete(item)
            else:
                new_qty = quantity if action == "set" else (
                    (item.quantity if item else 0) + quantity
                )
                if new_qty <= 0:
                    if item:
                        db.delete(item)
                else:
                    if item is None:
                        item = CartItem(cart_id=cart.id, product_id=product_id)
                        db.add(item)
                    item.offer_id = offer_id
                    item.quantity = new_qty
                    item.unit_price = unit_price
                    item.line_total = round(unit_price * new_qty, 2)

            db.flush()
            state = _cart_state(db, cart)
            # Attach live stock for the touched product so the agent can confirm
            # availability for the requested quantity.
            stock = sum(
                inv.quantity_available
                for inv in db.query(Inventory).filter(
                    Inventory.product_id == product_id
                )
            )
            line = next(
                (i for i in state["items"] if i["product_id"] == product_id), None
            )
            state["product_stock_available"] = stock
            state["requested_within_stock"] = line is None or line["quantity"] <= stock
            db.commit()
            return _dump(state)

    @tool
    def view_cart() -> str:
        """Show the current contents and total of the customer's cart."""
        with SessionLocal() as db:
            cart = _get_active_cart(db, conversation_id)
            state = _cart_state(db, cart)
            db.commit()
            return _dump(state)

    @tool
    def analyze_cost() -> str:
        """Analyze the cart: current total, what it would cost at base prices,
        and total savings from the applied offers."""
        with SessionLocal() as db:
            cart = _get_active_cart(db, conversation_id)
            items = db.query(CartItem).filter(CartItem.cart_id == cart.id).all()
            current_total = 0.0
            base_total = 0.0
            breakdown = []
            for it in items:
                product = db.get(Product, it.product_id)
                base = float(product.base_price) if product else float(it.unit_price)
                line_current = float(it.line_total)
                line_base = round(base * it.quantity, 2)
                current_total += line_current
                base_total += line_base
                breakdown.append(
                    {
                        "product": product.name if product else it.product_id,
                        "quantity": it.quantity,
                        "unit_price": float(it.unit_price),
                        "base_unit_price": base,
                        "line_total": line_current,
                        "line_savings": round(line_base - line_current, 2),
                    }
                )
            db.commit()
            return _dump(
                {
                    "current_total": round(current_total, 2),
                    "base_total": round(base_total, 2),
                    "total_savings": round(base_total - current_total, 2),
                    "breakdown": breakdown,
                }
            )

    @tool
    def place_order() -> str:
        """Place the order from the current cart. Verifies stock, decrements
        inventory, records the order, and starts a fresh cart."""
        with SessionLocal() as db:
            cart = _get_active_cart(db, conversation_id)
            items = db.query(CartItem).filter(CartItem.cart_id == cart.id).all()
            if not items:
                return _dump({"error": "cart is empty"})

            # Stock check first.
            for it in items:
                stock = sum(
                    inv.quantity_available
                    for inv in db.query(Inventory).filter(
                        Inventory.product_id == it.product_id
                    )
                )
                if stock < it.quantity:
                    product = db.get(Product, it.product_id)
                    return _dump(
                        {
                            "error": "insufficient stock",
                            "product": product.name if product else it.product_id,
                            "requested": it.quantity,
                            "available": stock,
                        }
                    )

            from .models import Conversation

            conv = db.get(Conversation, conversation_id)
            total = round(sum(float(it.line_total) for it in items), 2)
            order = Order(
                conversation_id=conversation_id,
                cart_id=cart.id,
                customer_id=conv.customer_id if conv else None,
                total=total,
                status="placed",
            )
            db.add(order)
            db.flush()

            for it in items:
                db.add(
                    OrderItem(
                        order_id=order.id,
                        product_id=it.product_id,
                        offer_id=it.offer_id,
                        quantity=it.quantity,
                        unit_price=it.unit_price,
                        line_total=it.line_total,
                    )
                )
                # Decrement stock from warehouses (simple: first warehouse).
                remaining = it.quantity
                for inv in db.query(Inventory).filter(
                    Inventory.product_id == it.product_id
                ):
                    take = min(inv.quantity_available, remaining)
                    inv.quantity_available -= take
                    remaining -= take
                    if remaining <= 0:
                        break

            cart.status = "ordered"
            db.flush()
            new_cart = Cart(conversation_id=conversation_id, status="active")
            db.add(new_cart)
            db.commit()
            return _dump(
                {"order_id": order.id, "total": total, "status": "placed"}
            )

    @tool
    def ask_user_question(question: str) -> str:
        """Record a clarifying question you need the customer to answer before
        you can proceed (e.g. quantity, delivery date, budget). Ask this when
        information is missing rather than guessing."""
        return _dump({"pending_question": question})

    return [
        get_products,
        get_product_info,
        get_offer,
        get_similar_offers,
        check_stock,
        update_cart,
        view_cart,
        analyze_cost,
        place_order,
        ask_user_question,
    ]
