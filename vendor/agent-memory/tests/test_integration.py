from __future__ import annotations

import tempfile
from pathlib import Path

from memory.api.agent_api import AgentMemory


def _temp_mem():
    tmp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    root = Path(tmp_dir.name) / "agent_test"
    mem = AgentMemory(root_dir=root)
    return tmp_dir, mem


class TestAgentMemory:
    def test_initialization(self):
        tmp_dir, mem = _temp_mem()
        try:
            assert mem.config.root_dir.exists()
            assert mem.config.history_dir.exists()
            assert mem.config.identity_path.exists()
        finally:
            mem.close()
            tmp_dir.cleanup()

    def test_record_and_build_messages(self):
        tmp_dir, mem = _temp_mem()
        try:
            mem.on_user_message("session-1", "Hello, my name is Kai")
            mem.on_assistant_message("session-1", "Hi Kai! How can I help?")
            messages = mem.build_context("session-1", "What is the weather?")
            assert len(messages) >= 2
            assert any("Kai" in m.get("content", "") for m in messages)
            assert messages[-1]["content"] == "What is the weather?"
        finally:
            mem.close()
            tmp_dir.cleanup()

    def test_remember_and_search(self):
        tmp_dir, mem = _temp_mem()
        try:
            mem.remember(
                wing="wing-project",
                room="room-tech-stack",
                content="Backend uses FastAPI with PostgreSQL",
            )
            mem.remember(
                wing="wing-project",
                room="room-tech-stack",
                content="Frontend uses React with TypeScript",
            )
            result = mem.search(query="Python backend framework", wing="wing-project", room="room-tech-stack")
            assert len(result.matches) > 0
            assert any("FastAPI" in m.content for m in result.matches)
        finally:
            mem.close()
            tmp_dir.cleanup()

    def test_remember_and_recall(self):
        tmp_dir, mem = _temp_mem()
        try:
            mem.remember(
                wing="wing-code",
                room="room-api",
                content="All REST endpoints require JWT Bearer token",
            )
            recalled = mem.recall(wing="wing-code", room="room-api", limit=3)
            assert len(recalled) > 0
        finally:
            mem.close()
            tmp_dir.cleanup()

    def test_knowledge_graph_facts(self):
        tmp_dir, mem = _temp_mem()
        try:
            mem.add_fact("Kai", "preferred_language", "Python")
            mem.add_fact("Kai", "works_on", "memory-agent")
            results = mem.query_entity("Kai")
            assert len(results) >= 2
        finally:
            mem.close()
            tmp_dir.cleanup()

    def test_status(self):
        tmp_dir, mem = _temp_mem()
        try:
            mem.remember(wing="wing-main", room="room-meta", content="system overview")
            status = mem.status()
            assert "wings" in status
            assert "knowledge_graph" in status
            assert "wing-main" in status["wings"]
        finally:
            mem.close()
            tmp_dir.cleanup()
