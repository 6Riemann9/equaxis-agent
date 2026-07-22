from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from memory.config import MemoryConfig
from memory.store.manager import MemoryManager
from memory.stack.layers import MemoryStack
from memory.stack.context_builder import ContextBuilder
from memory.types import HallType, MessageRole


class TestMemoryStack:
    @pytest.fixture
    def manager(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_:
            root = Path(tmp_) / "agent_test"
            config = MemoryConfig(root_dir=root)
            config.root_dir.mkdir(parents=True, exist_ok=True)
            config.history_dir.mkdir(parents=True, exist_ok=True)
            config.identity_path.write_text("# Agent Identity\nName: TestBot\nRole: testing", encoding="utf-8")
            config.user_path.write_text("# User\nName: Alice", encoding="utf-8")
            config.memory_path.write_text("# Memory\nTest project uses pytest", encoding="utf-8")
            yield MemoryManager(config)

    def test_load_identity(self, manager):
        stack = MemoryStack(manager)
        wakeup = stack.wake_up()
        assert "TestBot" in wakeup

    def test_search_recall(self, manager):
        manager.long_term.add_drawer(
            wing="wing-test",
            room="room-auth",
            content="JWT auth with RS256 algorithm",
            source_file="auth.md",
            hall=HallType.FACTS,
        )
        manager.long_term.add_drawer(
            wing="wing-test",
            room="room-auth",
            content="OAuth2 integration with Google provider",
            source_file="auth.md",
            hall=HallType.FACTS,
        )
        stack = MemoryStack(manager)
        result = stack.recall(wing="wing-test", room="room-auth", limit=3)
        assert len(result) > 0

    def test_compose_layers(self, manager):
        manager.long_term.add_drawer(
            wing="wing-main",
            room="room-db",
            content="Using PostgreSQL with pgvector extension",
            source_file="db.md",
            hall=HallType.FACTS,
        )
        stack = MemoryStack(manager)
        layers = stack.compose_layers(topic="database setup", wing="wing-main", room="room-db")
        assert layers.l0
        assert layers.l1 or layers.l2 or layers.l3

    def test_status(self, manager):
        manager.long_term.add_drawer(wing="wing-x", room="room-y", content="test", source_file="t.md")
        manager.knowledge_graph.add_entity("TestEntity", "concept")
        stack = MemoryStack(manager)
        status = stack.status()
        assert "wings" in status
        assert "knowledge_graph" in status


class TestContextBuilder:
    @pytest.fixture
    def manager(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_:
            root = Path(tmp_) / "agent_test"
            config = MemoryConfig(root_dir=root)
            config.root_dir.mkdir(parents=True, exist_ok=True)
            config.history_dir.mkdir(parents=True, exist_ok=True)
            config.identity_path.write_text("# Test Identity", encoding="utf-8")
            yield MemoryManager(config)

    def test_build_system_prompt(self, manager):
        builder = ContextBuilder(manager)
        prompt = builder.build_system_prompt()
        assert isinstance(prompt, str)
        assert len(prompt) > 0

    def test_build_messages(self, manager):
        builder = ContextBuilder(manager)
        messages = builder.build_messages(session_id="test-session", user_message="Hello")
        assert len(messages) >= 2
        assert messages[-1]["role"] == "user"
        assert messages[-1]["content"] == "Hello"

    def test_record_messages(self, manager):
        builder = ContextBuilder(manager)
        builder.record_user_message("test-session", "What is pytest?")
        session = manager.short_term.get_or_create_session("test-session")
        assert len(session.messages) == 1
        assert session.messages[0].content == "What is pytest?"
