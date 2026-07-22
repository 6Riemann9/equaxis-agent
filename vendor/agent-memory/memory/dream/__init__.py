from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Protocol

from memory.config import MemoryConfig
from memory.dream.consolidator import Consolidator
from memory.dream.phase1 import DreamPhase1
from memory.dream.phase2 import DreamPhase2
from memory.store.knowledge_graph import KnowledgeGraphStore
from memory.store.long_term import LongTermMemoryStore
from memory.store.short_term import ShortTermMemoryStore
from memory.types import DreamAnalysis, HistoryEntry
from memory.utils.git import GitStore


class LLMProvider(Protocol):
    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> str: ...


class ToolExecutor(Protocol):
    async def read_file(self, path: str) -> str: ...
    async def write_file(self, path: str, content: str) -> None: ...
    async def edit_file(self, path: str, old_text: str, new_text: str) -> None: ...


class Dream:
    def __init__(
        self,
        config: MemoryConfig,
        short_term: ShortTermMemoryStore,
        long_term: LongTermMemoryStore,
        knowledge_graph: KnowledgeGraphStore,
        llm: LLMProvider,
        tools: ToolExecutor | None = None,
    ):
        self.config = config
        self.short_term = short_term
        self.long_term = long_term
        self.knowledge_graph = knowledge_graph
        self.consolidator = Consolidator(config, llm)
        self.phase1 = DreamPhase1(config, llm)
        self.phase2 = DreamPhase2(config, llm, tools) if tools else None
        self.git = GitStore(config.root_dir)

    async def run(self) -> dict:
        dream_cursor = self.short_term.get_last_dream_cursor()
        analysis = await self.phase1.analyze(self.short_term, dream_cursor)
        if self.phase2 and (analysis.facts or analysis.skills or analysis.removals):
            result = await self.phase2.apply(analysis, self.long_term, self.knowledge_graph)
            result["phase"] = "phase1+phase2"
        else:
            result = {"phase": "phase1-only", "facts_found": len(analysis.facts), "skills_found": len(analysis.skills)}
        unprocessed = self.short_term.read_unprocessed_history(dream_cursor, limit=self.config.dream.max_batch_size)
        if unprocessed:
            last_cursor = unprocessed[-1].cursor
            self.short_term.set_last_dream_cursor(last_cursor)
        self.short_term.compact_history()
        self.git.auto_commit(f"dream: consolidated {len(analysis.facts)} facts, {len(analysis.skills)} skills, {len(analysis.removals)} removals")
        result["dream_cursor"] = self.short_term.get_last_dream_cursor()
        return result

    async def run_consolidation(self, messages: list[dict[str, str]], session_id: str) -> tuple[list[dict[str, str]], str | None]:
        return await self.consolidator.maybe_consolidate(messages, session_id)


__all__ = ["Dream", "Consolidator", "DreamPhase1", "DreamPhase2", "LLMProvider", "ToolExecutor"]
