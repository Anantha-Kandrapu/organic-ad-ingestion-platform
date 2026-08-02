from __future__ import annotations

from pydantic import BaseModel


class StartRequest(BaseModel):
    customer_id: int | None = None
    message: str | None = None


class StartResponse(BaseModel):
    conversation_id: int
    status: str


class ContinueRequest(BaseModel):
    message: str


class ContinueResponse(BaseModel):
    conversation_id: int
    status: str
