"""Input validation utilities for the memory system."""

from __future__ import annotations

import re
from typing import Any

from memory.exceptions import ValidationError


def validate_session_id(session_id: str) -> None:
    """Validate session ID format."""
    if not session_id or not isinstance(session_id, str):
        raise ValidationError("session_id must be a non-empty string")
    if len(session_id) > 256:
        raise ValidationError("session_id must be <= 256 characters")


def validate_content(content: str, field_name: str = "content", max_length: int = 100000) -> None:
    """Validate content string."""
    if not isinstance(content, str):
        raise ValidationError(f"{field_name} must be a string")
    if not content.strip():
        raise ValidationError(f"{field_name} cannot be empty or whitespace-only")
    if len(content) > max_length:
        raise ValidationError(f"{field_name} must be <= {max_length} characters")


def validate_wing_room(wing: str | None, room: str | None) -> None:
    """Validate wing and room identifiers."""
    pattern = re.compile(r"^[a-zA-Z0-9_-]+$")

    if wing is not None:
        if not isinstance(wing, str):
            raise ValidationError("wing must be a string")
        if not wing.strip():
            raise ValidationError("wing cannot be empty")
        if len(wing) > 128:
            raise ValidationError("wing must be <= 128 characters")
        if not pattern.match(wing):
            raise ValidationError("wing must contain only alphanumeric, underscore, or hyphen characters")

    if room is not None:
        if not isinstance(room, str):
            raise ValidationError("room must be a string")
        if not room.strip():
            raise ValidationError("room cannot be empty")
        if len(room) > 128:
            raise ValidationError("room must be <= 128 characters")
        if not pattern.match(room):
            raise ValidationError("room must contain only alphanumeric, underscore, or hyphen characters")


def validate_limit(limit: int, max_limit: int = 100) -> None:
    """Validate limit parameter."""
    if not isinstance(limit, int):
        raise ValidationError("limit must be an integer")
    if limit < 1:
        raise ValidationError("limit must be >= 1")
    if limit > max_limit:
        raise ValidationError(f"limit must be <= {max_limit}")


def validate_entity_name(name: str, field_name: str = "name") -> None:
    """Validate entity name."""
    if not isinstance(name, str):
        raise ValidationError(f"{field_name} must be a string")
    if not name.strip():
        raise ValidationError(f"{field_name} cannot be empty")
    if len(name) > 256:
        raise ValidationError(f"{field_name} must be <= 256 characters")


def validate_metadata(metadata: dict[str, Any] | None) -> None:
    """Validate metadata dictionary."""
    if metadata is None:
        return
    if not isinstance(metadata, dict):
        raise ValidationError("metadata must be a dictionary")
    for key in metadata.keys():
        if not isinstance(key, str):
            raise ValidationError("metadata keys must be strings")
        if len(key) > 128:
            raise ValidationError("metadata keys must be <= 128 characters")


def validate_confidence(confidence: float) -> None:
    """Validate confidence score."""
    if not isinstance(confidence, (int, float)):
        raise ValidationError("confidence must be a number")
    if not 0.0 <= confidence <= 1.0:
        raise ValidationError("confidence must be between 0.0 and 1.0")
