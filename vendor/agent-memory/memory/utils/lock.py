from __future__ import annotations

import asyncio
from threading import RLock


class SessionLock:
    def __init__(self):
        self._locks: dict[str, RLock] = {}
        self._guard = RLock()

    def get(self, session_key: str) -> RLock:
        with self._guard:
            if session_key not in self._locks:
                self._locks[session_key] = RLock()
            return self._locks[session_key]

    def remove(self, session_key: str) -> None:
        with self._guard:
            self._locks.pop(session_key, None)


class AsyncSessionLock:
    def __init__(self):
        self._locks: dict[str, asyncio.Lock] = {}
        self._guard = RLock()

    def get(self, session_key: str) -> asyncio.Lock:
        with self._guard:
            if session_key not in self._locks:
                self._locks[session_key] = asyncio.Lock()
            return self._locks[session_key]

    def remove(self, session_key: str) -> None:
        with self._guard:
            self._locks.pop(session_key, None)
