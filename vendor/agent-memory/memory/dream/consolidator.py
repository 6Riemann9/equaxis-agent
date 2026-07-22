from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Protocol

from memory.config import MemoryConfig
from memory.utils.lock import SessionLock
from memory.utils.token import estimate_tokens


class LLMProvider(Protocol):
    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> str: ...


class Consolidator:
    def __init__(self, config: MemoryConfig, llm: LLMProvider | None = None):
        self.config = config
        self.llm = llm
        self._session_locks = SessionLock()
        self._template: str | None = None

    def estimate_prompt_tokens(self, messages: list[dict[str, str]]) -> int:
        return estimate_tokens("".join(item.get("content", "") for item in messages))

    def should_consolidate(self, messages: list[dict[str, str]]) -> bool:
        estimated = self.estimate_prompt_tokens(messages)
        budget = self._input_budget()
        return estimated > budget

    def pick_consolidation_boundary(self, messages: list[dict[str, str]], tokens_to_remove: int) -> int:
        accumulated = 0
        for i, item in enumerate(messages):
            if item.get("role") != "user":
                accumulated += estimate_tokens(item.get("content", "")) + 4
                continue
            accumulated += 4
            if accumulated >= tokens_to_remove:
                return i + 1
        return max(1, len(messages) // 3)

    async def consolidate(self, messages: list[dict[str, str]], consolidate_index: int) -> str:
        archived = messages[:consolidate_index]
        text = "\n".join(f"[{item['role']}] {item['content']}" for item in archived)
        if len(text) > self.config.consolidation.raw_archive_max_chars:
            text = text[-self.config.consolidation.raw_archive_max_chars :]
            text = text[text.index("\n") + 1 :]
        if self.llm:
            return await self._llm_archive(text)
        return self._raw_archive(text)

    async def maybe_consolidate(
        self,
        messages: list[dict[str, str]],
        session_id: str,
    ) -> tuple[list[dict[str, str]], str | None]:
        lock = self._session_locks.get(session_id)
        with lock:
            for _ in range(5):
                estimated = self.estimate_prompt_tokens(messages)
                budget = self._input_budget()
                if estimated <= int(budget * self.config.consolidation.consolidation_ratio):
                    break
                removal = estimated - int(budget * self.config.consolidation.consolidation_ratio)
                boundary = self.pick_consolidation_boundary(messages, removal)
                if boundary < 1:
                    break
                summary = await self.consolidate(messages, boundary)
                remaining = messages[boundary:]
                messages = [{"role": "system", "content": f"[Archived context] {summary}"}] + remaining
                return messages, summary
        return messages, None

    def reset_messages(self, messages: list[dict[str, str]], consolidate_index: int) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
        archived = messages[:consolidate_index]
        remaining = messages[consolidate_index:]
        return remaining, archived

    def _input_budget(self) -> int:
        return self.config.consolidation.context_window_tokens - self.config.consolidation.max_completion_tokens - self.config.consolidation.safety_buffer_tokens

    async def _llm_archive(self, text: str) -> str:
        template = self._load_template()
        prompt = template.format(history_text=text)
        if not self.llm:
            return self._raw_archive(text)
        try:
            result = await self.llm.complete(
                [{"role": "user", "content": prompt}],
                max_tokens=200,
            )
            return result[: self.config.consolidation.archive_summary_max_chars]
        except Exception:
            return self._raw_archive(text)

    def _raw_archive(self, text: str) -> str:
        return text[-self.config.consolidation.raw_archive_max_chars :].strip()

    def _load_template(self) -> str:
        if self._template is None:
            template_path = Path(__file__).parent / "templates" / "consolidator_archive.txt"
            if template_path.exists():
                self._template = template_path.read_text(encoding="utf-8")
            else:
                self._template = "Summarize the following conversation in one short paragraph: {history_text}\n\nSummary:"
        return self._template
