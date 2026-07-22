"""Tests for exception handling."""

import tempfile
from pathlib import Path

import pytest

from memory import AgentMemory, ValidationError


class TestAgentMemoryValidation:
    def setup_method(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.mem = AgentMemory(root_dir=Path(self.tmp.name) / "test-memory")

    def teardown_method(self):
        self.mem.close()
        self.tmp.cleanup()

    def test_invalid_session_id(self):
        with pytest.raises(ValidationError):
            self.mem.on_user_message("", "Hello")

    def test_invalid_message_content(self):
        with pytest.raises(ValidationError):
            self.mem.on_user_message("session-1", "")

    def test_invalid_wing_room(self):
        with pytest.raises(ValidationError):
            self.mem.remember(wing="invalid wing", room="room", content="test")

    def test_missing_wing_room(self):
        with pytest.raises(ValidationError):
            self.mem.remember(wing="", room="", content="test")

    def test_invalid_search_query(self):
        with pytest.raises(ValidationError):
            self.mem.search(query="")

    def test_invalid_limit(self):
        with pytest.raises(ValidationError):
            self.mem.search(query="test", limit=0)

    def test_invalid_entity_name(self):
        with pytest.raises(ValidationError):
            self.mem.add_fact(subject="", predicate="uses", object_name="tool")

    def test_valid_operations(self):
        # These should not raise exceptions
        self.mem.on_user_message("session-1", "Hello")
        self.mem.on_assistant_message("session-1", "Hi there")
        self.mem.remember(wing="test", room="data", content="Test content")
        result = self.mem.search(query="test", limit=5)
        assert result is not None
        self.mem.add_fact("user", "likes", "python")
        facts = self.mem.query_entity("user")
        assert len(facts) > 0
