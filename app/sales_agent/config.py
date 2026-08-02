from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg2://sales:sales@db:5432/sales"
    redis_url: str = "redis://redis:6379/0"

    # Anthropic / model config. The app boots fine with no key; only agent
    # turns require it. Provide ANTHROPIC_API_KEY in the environment.
    anthropic_api_key: str | None = None
    claude_model: str = "claude-sonnet-5"
    max_tokens: int = 4096

    # How long (seconds) streamed events live in Redis before expiring.
    event_ttl_seconds: int = 900


settings = Settings()
