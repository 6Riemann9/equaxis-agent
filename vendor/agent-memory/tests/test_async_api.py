"""Tests for async API."""

import asyncio
import tempfile
from pathlib import Path

import pytest

from memory import AsyncAgentMemory, ValidationError
from memory.types import HallType


class TestAsyncAgentMemory:
    @pytest.fixture
    async def async_mem(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        mem = AsyncAgentMemory(root_dir=Path(tmp.name) / "test-async-memory")
        yield mem
        await mem.close()
        tmp.cleanup()

    @pytest.mark.asyncio
    async def test_async_context_manager(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        async with AsyncAgentMemory(root_dir=Path(tmp.name) / "test-ctx") as mem:
            await mem.on_user_message("session-1", "Hello")
            session = await mem.get_session("session-1")
            assert len(session.messages) == 1
        tmp.cleanup()

    @pytest.mark.asyncio
    async def test_on_user_message(self, async_mem):
        await async_mem.on_user_message("session-1", "Hello world")
        session = await async_mem.get_session("session-1")
        assert len(session.messages) == 1
        assert session.messages[0].content == "Hello world"

    @pytest.mark.asyncio
    async def test_on_assistant_message(self, async_mem):
        await async_mem.on_assistant_message("session-1", "Hi there")
        session = await async_mem.get_session("session-1")
        assert len(session.messages) == 1
        assert session.messages[0].content == "Hi there"

    @pytest.mark.asyncio
    async def test_remember_and_search(self, async_mem):
        await async_mem.remember(
            wing="test-wing",
            room="test-room",
            content="This is a test memory",
            hall=HallType.FACTS,
        )
        result = await async_mem.search(query="test memory", wing="test-wing", limit=5)
        assert len(result.matches) > 0
        assert "test memory" in result.matches[0].content.lower()

    @pytest.mark.asyncio
    async def test_add_fact_and_query(self, async_mem):
        await async_mem.add_fact("Alice", "knows", "Bob")
        await async_mem.add_fact("Alice", "works_at", "Company")
        facts = await async_mem.query_entity("Alice")
        assert len(facts) >= 2

    @pytest.mark.asyncio
    async def test_build_context(self, async_mem):
        await async_mem.on_user_message("session-1", "What is Python?")
        await async_mem.on_assistant_message("session-1", "Python is a programming language")
        context = await async_mem.build_context("session-1", "Tell me more")
        assert len(context) > 0

    @pytest.mark.asyncio
    async def test_status(self, async_mem):
        await async_mem.remember(wing="project", room="info", content="Test data")
        status = await async_mem.status()
        assert "config" in status
        assert "wings" in status
        assert "knowledge_graph" in status

    @pytest.mark.asyncio
    async def test_recall(self, async_mem):
        await async_mem.remember(wing="docs", room="api", content="API documentation")
        result = await async_mem.recall(wing="docs", room="api", limit=5)
        assert isinstance(result, str)

    @pytest.mark.asyncio
    async def test_validation_errors(self, async_mem):
        with pytest.raises(ValidationError):
            await async_mem.on_user_message("", "Hello")

        with pytest.raises(ValidationError):
            await async_mem.remember(wing="invalid wing", room="room", content="test")

        with pytest.raises(ValidationError):
            await async_mem.search(query="", limit=5)

    @pytest.mark.asyncio
    async def test_concurrent_operations(self, async_mem):
        # Test concurrent writes
        tasks = [
            async_mem.remember(wing="test", room=f"room-{i}", content=f"Content {i}")
            for i in range(10)
        ]
        results = await asyncio.gather(*tasks)
        assert len(results) == 10

        # Test concurrent searches
        search_tasks = [
            async_mem.search(query=f"Content {i}", wing="test", limit=3)
            for i in range(5)
        ]
        search_results = await asyncio.gather(*search_tasks)
        assert len(search_results) == 5

    @pytest.mark.asyncio
    async def test_concurrent_fact_operations(self, async_mem):
        # Add multiple facts concurrently
        tasks = [
            async_mem.add_fact(f"Entity{i}", "relates_to", f"Entity{i+1}")
            for i in range(5)
        ]
        await asyncio.gather(*tasks)

        # Query concurrently
        query_tasks = [
            async_mem.query_entity(f"Entity{i}")
            for i in range(5)
        ]
        results = await asyncio.gather(*query_tasks)
        assert len(results) == 5

    @pytest.mark.asyncio
    async def test_async_fact_ids_are_stable_for_repeated_calls(self, async_mem):
        first = await async_mem.add_fact("Alice", "knows", "Bob")
        second = await async_mem.add_fact("Alice", "knows", "Bob")

        assert first.triple_id == second.triple_id
        assert len(await async_mem.query_entity("Alice")) == 1

    @pytest.mark.asyncio
    async def test_async_error_propagates_from_threaded_operation(self, async_mem, monkeypatch):
        def fail_search(*args, **kwargs):
            raise RuntimeError("storage unavailable")

        monkeypatch.setattr(async_mem.manager, "search", fail_search)

        with pytest.raises(RuntimeError, match="storage unavailable"):
            await async_mem.search(query="anything", limit=1)

    def test_async_agent_memory_documents_threaded_facade(self):
        assert "asyncio.to_thread" in AsyncAgentMemory.__doc__
