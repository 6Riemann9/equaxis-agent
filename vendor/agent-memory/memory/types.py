from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any


class MessageRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class HallType(str, Enum):
    FACTS = "hall_facts"
    EVENTS = "hall_events"
    DISCOVERIES = "hall_discoveries"
    PREFERENCES = "hall_preferences"
    ADVICE = "hall_advice"
    GENERAL = "hall_general"


@dataclass(slots=True)
class Message:
    role: MessageRole
    content: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class SessionState:
    session_id: str
    messages: list[Message] = field(default_factory=list)
    last_consolidated_index: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class PalaceRef:
    id: str
    local_path: Path | None = None
    namespace: str | None = None


@dataclass(slots=True)
class DrawerRecord:
    drawer_id: str
    wing: str
    room: str
    hall: HallType
    content: str
    source_file: str
    chunk_index: int = 0
    added_by: str = "agent-memory"
    filed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ClosetRecord:
    closet_id: str
    wing: str
    room: str
    content: str
    drawer_ids: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class HistoryEntry:
    cursor: int
    timestamp: datetime
    content: str
    session_id: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class QueryMatch:
    id: str
    content: str
    metadata: dict[str, Any]
    score: float


@dataclass(slots=True)
class QueryResult:
    matches: list[QueryMatch] = field(default_factory=list)


@dataclass(slots=True)
class Entity:
    entity_id: str
    name: str
    entity_type: str
    properties: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass(slots=True)
class Triple:
    triple_id: str
    subject: str
    predicate: str
    object: str
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    confidence: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class MemoryFact:
    target: str
    content: str
    action: str = "add"
    confidence: float = 1.0


@dataclass(slots=True)
class SkillCandidate:
    name: str
    description: str
    evidence: list[str] = field(default_factory=list)


@dataclass(slots=True)
class DreamAnalysis:
    facts: list[MemoryFact] = field(default_factory=list)
    removals: list[MemoryFact] = field(default_factory=list)
    skills: list[SkillCandidate] = field(default_factory=list)
    raw_output: str = ""
