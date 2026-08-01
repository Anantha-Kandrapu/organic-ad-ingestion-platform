from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _now() -> datetime:
    return datetime.utcnow()


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    company: Mapped[str | None] = mapped_column(String(120), nullable=True)
    segment: Mapped[str] = mapped_column(String(40), default="wholesale")
    phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    email: Mapped[str | None] = mapped_column(String(120), nullable=True)


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(String(60), index=True)
    unit: Mapped[str] = mapped_column(String(20), default="case")
    base_price: Mapped[float] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="USD")

    offers: Mapped[list["Offer"]] = relationship(back_populates="product")
    inventory: Mapped[list["Inventory"]] = relationship(back_populates="product")


class Offer(Base):
    __tablename__ = "offers"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    min_quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2))
    discount_pct: Mapped[float] = mapped_column(Numeric(5, 2), default=0)
    valid_until: Mapped[str | None] = mapped_column(String(20), nullable=True)

    product: Mapped[Product] = relationship(back_populates="offers")


class Inventory(Base):
    __tablename__ = "inventory"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    warehouse: Mapped[str] = mapped_column(String(60), default="Main")
    quantity_available: Mapped[int] = mapped_column(Integer, default=0)

    product: Mapped[Product] = relationship(back_populates="inventory")


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(30), default="open")
    emotion: Mapped[str | None] = mapped_column(String(40), nullable=True)
    satisfaction_score: Mapped[float | None] = mapped_column(
        Numeric(4, 3), nullable=True
    )
    satisfaction_label: Mapped[str | None] = mapped_column(String(30), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_now, onupdate=_now
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Cart(Base):
    __tablename__ = "carts"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    items: Mapped[list["CartItem"]] = relationship(back_populates="cart")


class CartItem(Base):
    __tablename__ = "cart_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    cart_id: Mapped[int] = mapped_column(ForeignKey("carts.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    offer_id: Mapped[int | None] = mapped_column(ForeignKey("offers.id"), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2))
    line_total: Mapped[float] = mapped_column(Numeric(12, 2))

    cart: Mapped[Cart] = relationship(back_populates="items")


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"))
    cart_id: Mapped[int] = mapped_column(ForeignKey("carts.id"))
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id"), nullable=True
    )
    total: Mapped[float] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    status: Mapped[str] = mapped_column(String(20), default="placed")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    items: Mapped[list["OrderItem"]] = relationship(back_populates="order")


class OrderItem(Base):
    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    offer_id: Mapped[int | None] = mapped_column(ForeignKey("offers.id"), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2))
    line_total: Mapped[float] = mapped_column(Numeric(12, 2))

    order: Mapped[Order] = relationship(back_populates="items")
