from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Iterator

from memory.config import MemoryConfig
from memory.exceptions import SessionError, StorageError
from memory.types import HistoryEntry, Message, SessionState


class ShortTermMemoryStore:
    def __init__(self, config: MemoryConfig):
        self.config = config
        self._sessions: dict[str, SessionState] = {}
        self._lock = RLock()
        self._ensure_files()

    def get_or_create_session(self, session_id: str) -> SessionState:
        with self._lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = SessionState(session_id=session_id)
            return self._sessions[session_id]

    def append_message(self, session_id: str, message: Message) -> SessionState:
        with self._lock:
            session = self.get_or_create_session(session_id)
            session.messages.append(message)
            return session

    def append_history(self, session_id: str, content: str, metadata: dict | None = None) -> HistoryEntry:
        with self._lock:
            try:
                cursor = self._next_cursor()
                entry = HistoryEntry(
                    cursor=cursor,
                    timestamp=datetime.now(timezone.utc),
                    content=content,
                    session_id=session_id,
                    metadata=metadata or {},
                )
                with self.config.history_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(self._history_payload(entry), ensure_ascii=False) + "\n")
                self._write_int(self.config.cursor_path, cursor)
                self.compact_history()
                return entry
            except (IOError, OSError) as e:
                raise StorageError(f"Failed to append history: {e}") from e

    def read_unprocessed_history(self, since_cursor: int, limit: int | None = None) -> list[HistoryEntry]:
        if not self.config.history_path.exists():
            return []
        items: list[HistoryEntry] = []
        for entry in self._iter_history_entries():
            if entry.cursor <= since_cursor:
                continue
            items.append(entry)
            if limit is not None and len(items) >= limit:
                break
        return items

    def read_recent_history(self, limit: int | None = None, char_limit: int | None = None) -> list[HistoryEntry]:
        entries = self.read_unprocessed_history(0)
        if limit is not None:
            entries = entries[-limit:]
        if char_limit is None:
            return entries
        total = 0
        result: list[HistoryEntry] = []
        for entry in reversed(entries):
            total += len(entry.content)
            if total > char_limit:
                break
            result.append(entry)
        return list(reversed(result))

    def get_last_dream_cursor(self) -> int:
        return self._read_int(self.config.dream_cursor_path)

    def set_last_dream_cursor(self, cursor: int) -> None:
        # Monotonic advance: concurrent consolidators must never move the
        # cursor backwards (a rollback re-processes entries, producing
        # duplicate memories with non-deterministic LLM extraction).
        current = self.get_last_dream_cursor()
        self._write_int(self.config.dream_cursor_path, max(current, int(cursor)))

    def compact_history(self) -> None:
        entries = self.read_unprocessed_history(0)
        if len(entries) <= self.config.max_history_entries:
            return
        keep = entries[-self.config.max_history_entries :]
        self.config.history_path.write_text(
            "\n".join(json.dumps(self._history_payload(entry), ensure_ascii=False) for entry in keep) + "\n",
            encoding="utf-8",
        )

    def clear_session(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def _iter_history_entries(self) -> Iterator[HistoryEntry]:
        with self.config.history_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                yield self._history_from_payload(json.loads(line))

    def _ensure_files(self) -> None:
        self.config.history_dir.mkdir(parents=True, exist_ok=True)
        if not self.config.history_path.exists():
            self.config.history_path.write_text("", encoding="utf-8")
        if not self.config.cursor_path.exists():
            self.config.cursor_path.write_text("0\n", encoding="utf-8")
        if not self.config.dream_cursor_path.exists():
            self.config.dream_cursor_path.write_text("0\n", encoding="utf-8")

    def _next_cursor(self) -> int:
        current = self._read_int(self.config.cursor_path)
        if current <= 0:
            # The cursor file may be corrupt or missing; derive the next
            # cursor from the existing history so nothing is re-recorded.
            try:
                current = max(
                    (entry.cursor for entry in self._iter_history_entries()),
                    default=0,
                )
            except (OSError, ValueError):
                current = 0
            self._write_int(self.config.cursor_path, current)
        return current + 1

    @staticmethod
    def _history_payload(entry: HistoryEntry) -> dict:
        payload = asdict(entry)
        payload["timestamp"] = entry.timestamp.isoformat()
        return payload

    @staticmethod
    def _history_from_payload(payload: dict) -> HistoryEntry:
        return HistoryEntry(
            cursor=int(payload["cursor"]),
            timestamp=datetime.fromisoformat(payload["timestamp"]),
            content=str(payload["content"]),
            session_id=str(payload["session_id"]),
            metadata=dict(payload.get("metadata", {})),
        )

    @staticmethod
    def _read_int(path: Path) -> int:
        if not path.exists():
            return 0
        try:
            raw = path.read_text(encoding="utf-8").strip()
            return int(raw) if raw else 0
        except (OSError, ValueError):
            return 0

    @staticmethod
    def _write_int(path: Path, value: int) -> None:
        path.write_text(f"{value}\n", encoding="utf-8")
