from __future__ import annotations

import time

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


engine = create_engine(settings.database_url, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def wait_for_db(max_attempts: int = 30, delay: float = 2.0) -> None:
    """Block until Postgres accepts connections (compose starts them together)."""
    from sqlalchemy import text

    last_err: Exception | None = None
    for _ in range(max_attempts):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception as exc:  # pragma: no cover - startup race
            last_err = exc
            time.sleep(delay)
    raise RuntimeError(f"Database not reachable: {last_err}")


def init_db() -> None:
    # Import models so they register on Base.metadata, then create + seed.
    from . import models  # noqa: F401
    from .seed import seed_if_empty

    wait_for_db()
    Base.metadata.create_all(engine)
    seed_if_empty()
