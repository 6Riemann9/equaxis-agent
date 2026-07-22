from __future__ import annotations

from pathlib import Path
from typing import Any


class TokenCounter:
    def __init__(self):
        self._encoder = None
        self._init_attempted = False

    def count(self, text: str) -> int:
        if not self._encoder and not self._init_attempted:
            self._init_attempted = True
            self._encoder = TokenCounter._load_encoder()
        if self._encoder:
            return len(self._encoder.encode(text))
        return len(text) // 4

    @staticmethod
    def _load_encoder() -> Any | None:
        try:
            import tiktoken
            return tiktoken.get_encoding("cl100k_base")
        except Exception:
            return None


_DEFAULT_COUNTER = TokenCounter()


def estimate_tokens(text: str) -> int:
    return _DEFAULT_COUNTER.count(text)


def estimate_list_tokens(messages: list[dict[str, str]]) -> int:
    total = 0
    for item in messages:
        total += estimate_tokens(item.get("content", "")) + 4
    return total
