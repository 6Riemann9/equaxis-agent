"""Tests for input validation."""

import pytest

from memory.exceptions import ValidationError
from memory.validation import (
    validate_confidence,
    validate_content,
    validate_entity_name,
    validate_limit,
    validate_metadata,
    validate_session_id,
    validate_wing_room,
)


class TestSessionIdValidation:
    def test_valid_session_id(self):
        validate_session_id("session-123")
        validate_session_id("user_session_456")

    def test_empty_session_id(self):
        with pytest.raises(ValidationError, match="non-empty string"):
            validate_session_id("")

    def test_none_session_id(self):
        with pytest.raises(ValidationError, match="non-empty string"):
            validate_session_id(None)

    def test_too_long_session_id(self):
        with pytest.raises(ValidationError, match="<= 256 characters"):
            validate_session_id("x" * 257)


class TestContentValidation:
    def test_valid_content(self):
        validate_content("Hello world", "message")
        validate_content("A" * 1000, "content")

    def test_empty_content(self):
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_content("", "message")

    def test_whitespace_only_content(self):
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_content("   \n\t  ", "message")

    def test_too_long_content(self):
        with pytest.raises(ValidationError, match="<= 100000 characters"):
            validate_content("x" * 100001, "content")

    def test_custom_max_length(self):
        with pytest.raises(ValidationError, match="<= 50 characters"):
            validate_content("x" * 51, "field", max_length=50)


class TestWingRoomValidation:
    def test_valid_wing_room(self):
        validate_wing_room("my-project", "tech-stack")
        validate_wing_room("project_1", "room_2")
        validate_wing_room("abc123", "xyz789")

    def test_none_values(self):
        validate_wing_room(None, None)
        validate_wing_room("wing", None)
        validate_wing_room(None, "room")

    def test_invalid_characters_wing(self):
        with pytest.raises(ValidationError, match="alphanumeric"):
            validate_wing_room("my project", "room")

    def test_invalid_characters_room(self):
        with pytest.raises(ValidationError, match="alphanumeric"):
            validate_wing_room("wing", "my room")

    def test_empty_wing(self):
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_wing_room("", "room")

    def test_too_long_wing(self):
        with pytest.raises(ValidationError, match="<= 128 characters"):
            validate_wing_room("x" * 129, "room")


class TestLimitValidation:
    def test_valid_limit(self):
        validate_limit(1)
        validate_limit(50)
        validate_limit(100)

    def test_zero_limit(self):
        with pytest.raises(ValidationError, match=">= 1"):
            validate_limit(0)

    def test_negative_limit(self):
        with pytest.raises(ValidationError, match=">= 1"):
            validate_limit(-5)

    def test_too_large_limit(self):
        with pytest.raises(ValidationError, match="<= 100"):
            validate_limit(101)

    def test_custom_max_limit(self):
        with pytest.raises(ValidationError, match="<= 50"):
            validate_limit(51, max_limit=50)


class TestEntityNameValidation:
    def test_valid_entity_name(self):
        validate_entity_name("Kai")
        validate_entity_name("my-project")
        validate_entity_name("entity_123")

    def test_empty_entity_name(self):
        with pytest.raises(ValidationError, match="cannot be empty"):
            validate_entity_name("")

    def test_too_long_entity_name(self):
        with pytest.raises(ValidationError, match="<= 256 characters"):
            validate_entity_name("x" * 257)


class TestMetadataValidation:
    def test_valid_metadata(self):
        validate_metadata(None)
        validate_metadata({})
        validate_metadata({"key": "value"})
        validate_metadata({"a": 1, "b": [1, 2, 3], "c": {"nested": True}})

    def test_invalid_metadata_type(self):
        with pytest.raises(ValidationError, match="must be a dictionary"):
            validate_metadata("not a dict")

    def test_invalid_metadata_key_type(self):
        with pytest.raises(ValidationError, match="keys must be strings"):
            validate_metadata({123: "value"})

    def test_too_long_metadata_key(self):
        with pytest.raises(ValidationError, match="keys must be <= 128 characters"):
            validate_metadata({"x" * 129: "value"})


class TestConfidenceValidation:
    def test_valid_confidence(self):
        validate_confidence(0.0)
        validate_confidence(0.5)
        validate_confidence(1.0)

    def test_negative_confidence(self):
        with pytest.raises(ValidationError, match="between 0.0 and 1.0"):
            validate_confidence(-0.1)

    def test_too_large_confidence(self):
        with pytest.raises(ValidationError, match="between 0.0 and 1.0"):
            validate_confidence(1.1)

    def test_invalid_confidence_type(self):
        with pytest.raises(ValidationError, match="must be a number"):
            validate_confidence("0.5")
