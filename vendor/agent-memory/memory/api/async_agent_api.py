"""Async API for AgentMemory."""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from memory.config import MemoryConfig
from memory.dream import Dream
from memory.exceptions import ValidationError
from memory.loader import ConfigLoader
from memory.logging_config import get_logger
from memory.stack.context_builder import ContextBuilder
from memory.stack.layers import MemoryStack
from memory.store.manager import MemoryManager
from memory.types import HallType, QueryResult
from memory.validation import (
    validate_content,
    validate_entity_name,
    validate_limit,
    validate_metadata,
    validate_session_id,
    validate_wing_room,
)


logger = get_logger(__name__)


class AsyncLLMProvider(Protocol):
    """Protocol for async LLM providers."""

    async def complete(self, messages: list[dict[str, str]], *, max_tokens: int) -> str: ...


class AsyncAgentMemory:
    """Async/await facade for AgentMemory operations.

    Storage calls are executed with asyncio.to_thread around the synchronous
    stores. This makes the API convenient for async applications, but it is not
    a full native-async storage implementation.
    """

    def __init__(self, root_dir: str | Path, llm: AsyncLLMProvider | None = None):
        self.root_dir = Path(root_dir).resolve()
        self.llm = llm
        logger.info(f"Initializing AsyncAgentMemory at {self.root_dir}")
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
            logger.info("Dream mechanism enabled with async LLM provider")
        else:
            self.dream = None
            logger.debug("Dream mechanism disabled (no LLM provider)")

    async def on_user_message(self, session_id: str, message: str) -> None:
        """Record a user message asynchronously."""
        validate_session_id(session_id)
        validate_content(message, "message")
        await asyncio.to_thread(self.context_builder.record_user_message, session_id, message)

    async def on_assistant_message(self, session_id: str, message: str) -> None:
        """Record an assistant message asynchronously."""
        validate_session_id(session_id)
        validate_content(message, "message")
        await asyncio.to_thread(self.context_builder.record_assistant_message, session_id, message)

    async def build_context(
        self,
        session_id: str,
        user_message: str,
        *,
        topic: str | None = None,
        wing: str | None = None,
        room: str | None = None,
    ) -> list[dict[str, str]]:
        """Build LLM context asynchronously."""
        validate_session_id(session_id)
        validate_content(user_message, "user_message")
        validate_wing_room(wing, room)
        return await asyncio.to_thread(
            self.context_builder.build_messages,
            session_id=session_id,
            user_message=user_message,
            topic=topic,
            wing=wing,
            room=room,
        )

    async def search(
        self, query: str, wing: str | None = None, room: str | None = None, limit: int = 5
    ) -> QueryResult:
        """Search memories asynchronously."""
        validate_content(query, "query", max_length=1000)
        validate_wing_room(wing, room)
        validate_limit(limit)
        logger.debug(f"Async searching: query='{query[:50]}...', wing={wing}, room={room}, limit={limit}")
        result = await asyncio.to_thread(self.manager.search, query=query, wing=wing, room=room, limit=limit)
        logger.debug(f"Search returned {len(result.matches)} matches")
        return result

    async def remember(
        self,
        wing: str,
        room: str,
        content: str,
        source_file: str = "api",
        hall: HallType = HallType.GENERAL,
        metadata: dict[str, Any] | None = None,
    ):
        """Store a memory asynchronously."""
        validate_wing_room(wing, room)
        if not wing or not room:
            raise ValidationError("wing and room are required for remember()")
        validate_content(content, "content")
        validate_content(source_file, "source_file", max_length=256)
        validate_metadata(metadata)
        logger.info(f"Storing memory: wing={wing}, room={room}, hall={hall.value}")
        result = await asyncio.to_thread(
            self.manager.long_term.add_drawer,
            wing=wing,
            room=room,
            content=content,
            source_file=source_file,
            hall=hall,
            metadata=metadata,
        )
        logger.debug(f"Memory stored with ID: {result.drawer_id}")
        return result

    async def recall(self, wing: str | None = None, room: str | None = None, limit: int = 5) -> str:
        """Recall memories asynchronously."""
        validate_wing_room(wing, room)
        validate_limit(limit)
        return await asyncio.to_thread(self.memory_stack.recall, wing=wing, room=room, limit=limit)

    async def add_fact(
        self,
        subject: str,
        predicate: str,
        object_name: str,
        metadata: dict[str, Any] | None = None,
        source_ref: str = "",
        source_quote: str = "",
    ):
        """Add a fact to the knowledge graph asynchronously."""
        validate_entity_name(subject, "subject")
        validate_entity_name(predicate, "predicate")
        validate_entity_name(object_name, "object_name")
        validate_metadata(metadata)
        logger.info(f"Adding fact: {subject} --{predicate}--> {object_name}")
        return await asyncio.to_thread(
            self.manager.knowledge_graph.add_triple,
            subject,
            predicate,
            object_name,
            metadata=metadata,
            source_ref=source_ref,
            source_quote=source_quote,
        )

    async def query_entity(self, name: str) -> list[dict[str, Any]]:
        """Query entity from knowledge graph asynchronously."""
        validate_entity_name(name, "name")
        return await asyncio.to_thread(self.manager.knowledge_graph.query_entity, name)

    async def get_session(self, session_id: str):
        """Get session state asynchronously."""
        validate_session_id(session_id)
        return await asyncio.to_thread(self.manager.short_term.get_or_create_session, session_id)

    async def status(self) -> dict[str, Any]:
        """Get system status asynchronously."""
        return await asyncio.to_thread(
            lambda: {
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
        )

    async def run_dream(self) -> dict:
        """Run dream consolidation asynchronously."""
        if self.dream is None:
            logger.warning("Dream requested but no LLM provider configured")
            return {"error": "No LLM provider configured. Dream requires an LLM."}
        logger.info("Running dream consolidation")
        result = await self.dream.run()
        logger.info(f"Dream completed: {result}")
        return result

    async def consolidate(self, messages: list[dict[str, str]], session_id: str) -> list[dict[str, str]]:
        """Consolidate context window asynchronously."""
        if self.dream is None:
            return messages
        result, _ = await self.dream.consolidator.maybe_consolidate(messages, session_id)
        return result

    async def close(self) -> None:
        """Close the memory system asynchronously."""
        logger.info("Closing AsyncAgentMemory")
        await asyncio.to_thread(self.manager.long_term.close)
        logger.debug("AsyncAgentMemory closed successfully")

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()
        return False
