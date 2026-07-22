from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from memory.config import MemoryConfig, build_default_config
from memory.dream import Dream
from memory.dream.consolidator import Consolidator
from memory.exceptions import ValidationError
from memory.loader import ConfigLoader
from memory.logging_config import get_logger
from memory.stack.context_builder import ContextBuilder
from memory.stack.layers import MemoryStack
from memory.store.knowledge_graph import KnowledgeGraphStore
from memory.store.long_term import LongTermMemoryStore
from memory.store.manager import MemoryManager
from memory.store.short_term import ShortTermMemoryStore
from memory.types import (
    DreamAnalysis,
    HallType,
    HistoryEntry,
    Message,
    MessageRole,
    QueryResult,
)
from memory.validation import (
    validate_content,
    validate_entity_name,
    validate_limit,
    validate_metadata,
    validate_session_id,
    validate_wing_room,
)


logger = get_logger(__name__)


class LLMProvider(Protocol):
    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> str: ...


class AgentMemory:
    def __init__(self, root_dir: str | Path, llm: LLMProvider | None = None):
        self.root_dir = Path(root_dir).resolve()
        self.llm = llm
        logger.info(f"Initializing AgentMemory at {self.root_dir}")
        self.config = ConfigLoader(self.root_dir).initialize_layout()
        self.manager = MemoryManager(self.config)
        self.context_builder = ContextBuilder(self.manager)
        self.memory_stack = MemoryStack(self.manager)
        if llm:
            self.dream = Dream(
                self.config,
                self.manager.short_term,
                self.manager.long_term,
                self.manager.knowledge_graph,
                llm,
            )
            logger.info("Dream mechanism enabled with LLM provider")
        else:
            self.dream = None
            logger.debug("Dream mechanism disabled (no LLM provider)")

    def on_user_message(self, session_id: str, message: str) -> None:
        validate_session_id(session_id)
        validate_content(message, "message")
        self.context_builder.record_user_message(session_id, message)

    def on_assistant_message(self, session_id: str, message: str) -> None:
        validate_session_id(session_id)
        validate_content(message, "message")
        self.context_builder.record_assistant_message(session_id, message)

    def build_context(
        self,
        session_id: str,
        user_message: str,
        *,
        topic: str | None = None,
        wing: str | None = None,
        room: str | None = None,
    ) -> list[dict[str, str]]:
        validate_session_id(session_id)
        validate_content(user_message, "user_message")
        validate_wing_room(wing, room)
        return self.context_builder.build_messages(
            session_id=session_id,
            user_message=user_message,
            topic=topic,
            wing=wing,
            room=room,
        )

    def search(self, query: str, wing: str | None = None, room: str | None = None, limit: int = 5) -> QueryResult:
        validate_content(query, "query", max_length=1000)
        validate_wing_room(wing, room)
        validate_limit(limit)
        logger.debug(f"Searching: query='{query[:50]}...', wing={wing}, room={room}, limit={limit}")
        result = self.manager.search(query=query, wing=wing, room=room, limit=limit)
        logger.debug(f"Search returned {len(result.matches)} matches")
        return result

    def remember(
        self,
        wing: str,
        room: str,
        content: str,
        source_file: str = "api",
        hall: HallType = HallType.GENERAL,
        metadata: dict[str, Any] | None = None,
    ):
        validate_wing_room(wing, room)
        if not wing or not room:
            raise ValidationError("wing and room are required for remember()")
        validate_content(content, "content")
        validate_content(source_file, "source_file", max_length=256)
        validate_metadata(metadata)
        logger.info(f"Storing memory: wing={wing}, room={room}, hall={hall.value}")
        result = self.manager.long_term.add_drawer(
            wing=wing,
            room=room,
            content=content,
            source_file=source_file,
            hall=hall,
            metadata=metadata,
        )
        logger.debug(f"Memory stored with ID: {result.drawer_id}")
        return result

    def recall(self, wing: str | None = None, room: str | None = None, limit: int = 5) -> str:
        validate_wing_room(wing, room)
        validate_limit(limit)
        return self.memory_stack.recall(wing=wing, room=room, limit=limit)

    def add_fact(self, subject: str, predicate: str, object_name: str, metadata: dict[str, Any] | None = None):
        validate_entity_name(subject, "subject")
        validate_entity_name(predicate, "predicate")
        validate_entity_name(object_name, "object_name")
        validate_metadata(metadata)
        logger.info(f"Adding fact: {subject} --{predicate}--> {object_name}")
        return self.manager.knowledge_graph.add_triple(subject, predicate, object_name, metadata=metadata)

    def query_entity(self, name: str) -> list[dict[str, Any]]:
        validate_entity_name(name, "name")
        return self.manager.knowledge_graph.query_entity(name)

    def get_session(self, session_id: str):
        validate_session_id(session_id)
        return self.manager.short_term.get_or_create_session(session_id)

    def status(self) -> dict[str, Any]:
        return {
            "config": {
                "root_dir": str(self.config.root_dir),
                "history_entries": len(self.manager.short_term.read_unprocessed_history(0)),
            },
            "wings": self.manager.long_term.list_wings(),
            "knowledge_graph": self.manager.knowledge_graph.stats(),
            "dream": {
                "last_cursor": self.manager.short_term.get_last_dream_cursor(),
            },
        }

    async def run_dream(self) -> dict:
        if self.dream is None:
            logger.warning("Dream requested but no LLM provider configured")
            return {"error": "No LLM provider configured. Dream requires an LLM."}
        logger.info("Running dream consolidation")
        result = await self.dream.run()
        logger.info(f"Dream completed: {result}")
        return result

    async def consolidate(self, messages: list[dict[str, str]], session_id: str) -> list[dict[str, str]]:
        if self.dream is None:
            return messages
        result, _ = await self.dream.consolidator.maybe_consolidate(messages, session_id)
        return result

    def close(self) -> None:
        logger.info("Closing AgentMemory")
        self.manager.long_term.close()
        logger.debug("AgentMemory closed successfully")
