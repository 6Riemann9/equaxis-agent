from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from memory.config import MemoryConfig
from memory.store.short_term import ShortTermMemoryStore


class TestShortTermMemoryStore:
    @pytest.fixture
    def store(self):
        with tempfile.TemporaryDirectory() as tmp_:
            root = Path(tmp_) / "agent_test"
            yield ShortTermMemoryStore(MemoryConfig(root_dir=root))

    def test_init_creates_files(self, store):
        assert store.config.history_dir.exists()
        assert store.config.history_path.exists()
        assert store.config.cursor_path.exists()
        assert store.config.dream_cursor_path.exists()

    def test_append_history_writes_jsonl(self, store):
        entry = store.append_history("test-session", "User said hello")
        assert entry.cursor == 1
        lines = store.config.history_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 1
        payload = json.loads(lines[0])
        assert payload["content"] == "User said hello"
        assert payload["cursor"] == 1
        assert payload["session_id"] == "test-session"

    def test_cursor_increments(self, store):
        store.append_history("s1", "msg1")
        store.append_history("s2", "msg2")
        assert len(store.read_unprocessed_history(0)) == 2
        entry = store.append_history("s3", "msg3")
        assert entry.cursor == 3

    def test_read_unprocessed_with_cursor(self, store):
        store.append_history("s1", "msg1")
        store.append_history("s1", "msg2")
        store.append_history("s1", "msg3")
        entries = store.read_unprocessed_history(1)
        assert len(entries) == 2
        assert entries[0].content == "msg2"
        assert entries[1].content == "msg3"

    def test_read_recent_history_limit(self, store):
        for i in range(5):
            store.append_history("s1", f"msg{i}")
        entries = store.read_recent_history(limit=3)
        assert len(entries) == 3
        assert entries[-1].content == "msg4"

    def test_read_recent_history_char_limit(self, store):
        store.append_history("s1", "short")
        store.append_history("s1", "very long message " + "x" * 200)
        entries = store.read_recent_history(char_limit=50)
        assert len(entries) <= 2

    def test_dream_cursor(self, store):
        assert store.get_last_dream_cursor() == 0
        store.set_last_dream_cursor(5)
        assert store.get_last_dream_cursor() == 5

    def test_compact_history(self, store):
        store.config.max_history_entries = 3
        for i in range(10):
            store.append_history("s1", f"msg{i}")
        store.compact_history()
        entries = store.read_unprocessed_history(0)
        assert len(entries) == 3

    def test_read_unprocessed_history_respects_limit(self, store):
        for i in range(20):
            store.append_history("s1", f"msg{i}")

        entries = store.read_unprocessed_history(5, limit=4)

        assert [entry.cursor for entry in entries] == [6, 7, 8, 9]
        assert [entry.content for entry in entries] == ["msg5", "msg6", "msg7", "msg8"]

    def test_read_unprocessed_history_handles_large_jsonl(self, store):
        for i in range(100):
            store.append_history("s1", f"msg{i}")

        entries = store.read_unprocessed_history(95)

        assert [entry.cursor for entry in entries] == [96, 97, 98, 99, 100]
        assert entries[-1].content == "msg99"

    def test_compact_history_preserves_recent_record_order(self, store):
        store.config.max_history_entries = 4
        for i in range(12):
            store.append_history("s1", f"msg{i}")

        store.compact_history()
        entries = store.read_unprocessed_history(0)

        assert [entry.content for entry in entries] == ["msg8", "msg9", "msg10", "msg11"]

    def test_compact_history_handles_empty_history(self, store):
        store.compact_history()

        assert store.read_unprocessed_history(0) == []

    def test_session_messages(self, store):
        from memory.types import Message, MessageRole

        session = store.get_or_create_session("test-session")
        assert session.session_id == "test-session"
        assert len(session.messages) == 0

        store.append_message("test-session", Message(role=MessageRole.USER, content="hello"))
        store.append_message("test-session", Message(role=MessageRole.ASSISTANT, content="hi"))

        session = store.get_or_create_session("test-session")
        assert len(session.messages) == 2
