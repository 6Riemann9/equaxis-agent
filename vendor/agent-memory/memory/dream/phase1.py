from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

from memory.config import MemoryConfig
from memory.store.knowledge_graph import KnowledgeGraphStore
from memory.store.long_term import LongTermMemoryStore
from memory.store.short_term import ShortTermMemoryStore
from memory.types import DreamAnalysis, MemoryFact, SkillCandidate


class LLMProvider(Protocol):
    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> str: ...


class DreamPhase1:
    def __init__(self, config: MemoryConfig, llm: LLMProvider):
        self.config = config
        self.llm = llm
        self._template: str | None = None

    async def analyze(
        self,
        short_term: ShortTermMemoryStore,
        dream_cursor: int,
    ) -> DreamAnalysis:
        history_entries = short_term.read_unprocessed_history(dream_cursor, limit=self.config.dream.max_batch_size)
        if not history_entries:
            return DreamAnalysis(raw_output="# No new history to process")
        history_text = self._format_history(history_entries)
        memory_content = self._read_or_default(self.config.memory_path)
        soul_content = self._read_or_default(self.config.user_path)
        user_content = self._read_or_default(self.config.identity_path)
        memory_content = self._annotate_ages(memory_content)
        template = self._load_template()
        prompt = template.format(
            current_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            memory_content=memory_content,
            soul_content=soul_content,
            user_content=user_content,
            history_text=history_text,
        )
        response = await self.llm.complete(
            [{"role": "user", "content": prompt}],
            max_tokens=2000,
        )
        return self._parse_response(response)

    def _parse_response(self, response: str) -> DreamAnalysis:
        analysis = DreamAnalysis(raw_output=response)
        for line in response.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            match = re.match(r'\[FILE-REMOVE:(\w+\.?(?:\w+)?)\]\s*(.*)', line)
            if match:
                target, reason = match.group(1), match.group(2)
                if target == "MEMORY":
                    target = "MEMORY.md"
                elif target == "USER":
                    target = "USER.md"
                elif target == "SOUL":
                    target = "SOUL.md"
                analysis.removals.append(MemoryFact(target=target, content=reason, action="remove", confidence=1.0))
                continue
            match = re.match(r'\[FILE:(\w+\.?(?:\w+)?)\]\s*(.*)', line)
            if match:
                target, content = match.group(1), match.group(2)
                if target == "MEMORY":
                    target = "MEMORY.md"
                elif target == "USER":
                    target = "USER.md"
                elif target == "SOUL":
                    target = "SOUL.md"
                analysis.facts.append(MemoryFact(target=target, content=content, action="add", confidence=1.0))
                continue
            match = re.match(r'\[SKILL:([\w-]+)\]\s*(.*)', line)
            if match:
                name, desc = match.group(1), match.group(2)
                analysis.skills.append(SkillCandidate(name=name, description=desc))
        return analysis

    def _annotate_ages(self, memory_content: str) -> str:
        if not self.config.dream.annotate_line_ages:
            return memory_content
        try:
            from memory.utils.git import GitStore
            git = GitStore(self.config.root_dir)
            lines = memory_content.split("\n")
            aged = []
            for line, age_days in git.line_ages(self.config.memory_path):
                if age_days > 14:
                    aged.append(f"{line}  ← {age_days}d")
                else:
                    aged.append(line)
            return "\n".join(aged)
        except Exception:
            return memory_content

    def _format_history(self, entries) -> str:
        parts = []
        for entry in entries:
            ts = entry.timestamp.strftime("%Y-%m-%d %H:%M")
            parts.append(f"[{ts}] {entry.content}")
        return "\n".join(parts)

    def _read_or_default(self, path: Path) -> str:
        if path.exists():
            return path.read_text(encoding="utf-8")
        return ""

    def _load_template(self) -> str:
        if self._template is None:
            template_path = Path(__file__).parent / "templates" / "dream_phase1.txt"
            if template_path.exists():
                self._template = template_path.read_text(encoding="utf-8")
            else:
                self._template = "Analyze the following history and extract facts:\n{history_text}\n\nAnalysis:"
        return self._template
