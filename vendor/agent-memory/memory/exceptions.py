"""Custom exceptions for the memory system."""

from __future__ import annotations


class MemoryError(Exception):
    """Base exception for all memory system errors."""


class ValidationError(MemoryError):
    """Raised when input validation fails."""


class ConfigurationError(MemoryError):
    """Raised when configuration is invalid or missing."""


class StorageError(MemoryError):
    """Raised when storage operations fail."""


class SessionError(MemoryError):
    """Raised when session operations fail."""


class KnowledgeGraphError(MemoryError):
    """Raised when knowledge graph operations fail."""


class SearchError(MemoryError):
    """Raised when search operations fail."""
