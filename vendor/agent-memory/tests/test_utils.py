from __future__ import annotations

import tempfile
from pathlib import Path

from memory.utils.token import estimate_tokens, estimate_list_tokens
from memory.utils.lock import SessionLock
from memory.utils.git import GitStore
from memory.config import MemoryConfig


class TestTokenCounter:
    def test_estimate_tokens_returns_int(self):
        result = estimate_tokens("Hello world")
        assert isinstance(result, int)
        assert result > 0

    def test_estimate_list_tokens(self):
        messages = [
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": "Hello"},
        ]
        tokens = estimate_list_tokens(messages)
        assert tokens > 10

    def test_token_scales_with_length(self):
        short_tokens = estimate_tokens("hi")
        long_tokens = estimate_tokens("hello " * 100)
        assert long_tokens > short_tokens


class TestSessionLock:
    def test_get_returns_reentrant_lock(self):
        slock = SessionLock()
        lock = slock.get("test-session")
        assert lock is not None
        lock.acquire()
        lock.release()

    def test_same_session_same_lock(self):
        slock = SessionLock()
        lock1 = slock.get("session-a")
        lock2 = slock.get("session-a")
        assert lock1 is lock2

    def test_different_sessions_different_locks(self):
        slock = SessionLock()
        lock1 = slock.get("session-1")
        lock2 = slock.get("session-2")
        assert lock1 is not lock2

    def test_remove_lock(self):
        slock = SessionLock()
        slock.get("temp-session")
        slock.remove("temp-session")
        new_lock = slock.get("temp-session")
        assert new_lock is not None


class TestGitStore:
    def test_auto_commit_no_error(self):
        with tempfile.TemporaryDirectory() as tmp_:
            root = Path(tmp_)
            git = GitStore(root)
            result = git.auto_commit("test commit")
            assert isinstance(result, bool)

    def test_log_returns_list(self):
        with tempfile.TemporaryDirectory() as tmp_:
            root = Path(tmp_)
            git = GitStore(root)
            log = git.log(max_entries=2)
            assert isinstance(log, list)
