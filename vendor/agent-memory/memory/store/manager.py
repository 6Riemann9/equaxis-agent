from __future__ import annotations

from memory.config import MemoryConfig
from memory.store.knowledge_graph import KnowledgeGraphStore
from memory.store.long_term import LongTermMemoryStore
from memory.store.short_term import ShortTermMemoryStore
from memory.types import HallType, Message, QueryResult


class MemoryManager:
    def __init__(self, config: MemoryConfig):
        self.config = config
        self.short_term = ShortTermMemoryStore(config)
        self.long_term = LongTermMemoryStore(config)
        self.knowledge_graph = KnowledgeGraphStore(config)

    def append_message(self, session_id: str, message: Message) -> None:
        self.short_term.append_message(session_id, message)

    def archive_text(self, session_id: str, content: str, metadata: dict | None = None) -> None:
        self.short_term.append_history(session_id, content, metadata=metadata)

    def search(self, query: str, wing: str | None = None, room: str | None = None, limit: int = 5) -> QueryResult:
        return self.long_term.search(query=query, wing=wing, room=room, limit=limit)

    def add_memory(
        self,
        wing: str,
        room: str,
        content: str,
        source_file: str,
        hall: HallType = HallType.GENERAL,
        metadata: dict | None = None,
    ):
        return self.long_term.add_drawer(
            wing=wing,
            room=room,
            content=content,
            source_file=source_file,
            hall=hall,
            metadata=metadata,
        )

    def add_fact(
        self,
        subject: str,
        predicate: str,
        object_name: str,
        metadata: dict | None = None,
    ):
        return self.knowledge_graph.add_triple(subject, predicate, object_name, metadata=metadata)

    def recent_history_text(self) -> str:
        entries = self.short_term.read_recent_history(
            limit=self.config.recent_history_limit,
            char_limit=self.config.recent_history_char_limit,
        )
        return "\n".join(entry.content for entry in entries)

    def durable_memory_text(self) -> str:
        sections = []
        for path in (self.config.identity_path, self.config.user_path, self.config.memory_path):
            if path.exists():
                sections.append(path.read_text(encoding="utf-8").strip())
        return "\n\n".join(section for section in sections if section)

    def close(self) -> None:
        self.long_term.close()
