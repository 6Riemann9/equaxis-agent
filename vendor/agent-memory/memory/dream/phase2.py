from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from memory.config import MemoryConfig
from memory.store.knowledge_graph import KnowledgeGraphStore
from memory.store.long_term import LongTermMemoryStore
from memory.types import DreamAnalysis, HallType, MemoryFact, SkillCandidate


class LLMProvider(Protocol):
    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> str: ...


class ToolExecutor(Protocol):
    async def read_file(self, path: str) -> str: ...
    async def write_file(self, path: str, content: str) -> None: ...
    async def edit_file(self, path: str, old_text: str, new_text: str) -> None: ...


class DreamPhase2:
    def __init__(self, config: MemoryConfig, llm: LLMProvider, tools: ToolExecutor):
        self.config = config
        self.llm = llm
        self.tools = tools
        self._template: str | None = None

    async def apply(
        self,
        analysis: DreamAnalysis,
        long_term: LongTermMemoryStore,
        knowledge_graph: KnowledgeGraphStore,
    ) -> dict:
        step_count = 0
        results = {"files_edited": 0, "skills_created": 0, "facts_added": 0, "removals_done": 0}
        template = self._load_template()
        memory_content = self._read_or_default(self.config.memory_path)
        user_content = self._read_or_default(self.config.user_path)
        soul_content = self._read_or_default(self.config.identity_path)
        skills_list = self._list_existing_skills()
        directives = "\n".join(analysis.raw_output.splitlines())
        prompt = template.format(
            current_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            memory_content=memory_content,
            user_content=user_content,
            soul_content=soul_content,
            skills_list=skills_list if skills_list else "(none)",
            directives=directives,
        )
        for iteration in range(self.config.dream.max_iterations):
            response = await self.llm.complete(
                [{"role": "user", "content": prompt}],
                max_tokens=3000,
            )
            actions = self._parse_actions(response)
            if not actions:
                break
            for action in actions:
                if action["type"] == "edit_file" and action["path"].endswith(".md"):
                    results["files_edited"] += 1
                    results["facts_added"] += 1
                elif action["type"] == "write_file" and action["path"].startswith("skills/"):
                    results["skills_created"] += 1
            step_count += len(actions)
        for fact in analysis.facts:
            try:
                wing = "default"
                room = self._derive_room(fact.content)
                long_term.add_drawer(
                    wing=wing,
                    room=room,
                    content=fact.content,
                    source_file=f"dream:{fact.target}",
                    hall=HallType.FACTS,
                )
                results["facts_added"] += 1
            except Exception:
                pass
        for removal in analysis.removals:
            results["removals_done"] += 1
        return results

    def _parse_actions(self, response: str) -> list[dict]:
        actions: list[dict] = []
        blocks = re.split(r'===\s*([\w./-]+)\s*===', response)
        i = 1
        while i < len(blocks) - 1:
            filename = blocks[i].strip()
            content = blocks[i + 1].strip()
            if filename.endswith(".md") and content:
                actions.append({
                    "type": "edit_file",
                    "path": filename,
                    "content": content,
                })
            elif filename.startswith("skills/") and content:
                actions.append({
                    "type": "write_file",
                    "path": filename,
                    "content": content,
                })
            i += 2
        return actions

    def _derive_room(self, content: str) -> str:
        keywords = {
            "auth": ["auth", "login", "password", "oauth", "token"],
            "api": ["api", "endpoint", "route", "handler", "rest"],
            "db": ["database", "sql", "query", "migration", "schema"],
            "config": ["config", "setting", "env", "environment"],
            "ui": ["ui", "frontend", "component", "style", "css"],
            "test": ["test", "spec", "pytest", "unittest"],
            "deploy": ["deploy", "docker", "kubernetes", "pipeline", "ci"],
            "bug": ["bug", "error", "crash", "fix", "issue"],
        }
        lower = content.lower()
        for room, terms in keywords.items():
            for term in terms:
                if term in lower:
                    return room
        return "general"

    def _read_or_default(self, path: Path) -> str:
        if path.exists():
            return path.read_text(encoding="utf-8")
        return ""

    def _list_existing_skills(self) -> str:
        skills_dir = self.config.skills_path
        if not skills_dir.exists():
            return ""
        names = [d.name for d in skills_dir.iterdir() if d.is_dir()]
        return "\n".join(f"- {name}" for name in names)

    def _load_template(self) -> str:
        if self._template is None:
            template_path = Path(__file__).parent / "templates" / "dream_phase2.txt"
            if template_path.exists():
                self._template = template_path.read_text(encoding="utf-8")
            else:
                self._template = "Apply the following memory updates:\n{directives}\n\nUpdates:"
        return self._template
