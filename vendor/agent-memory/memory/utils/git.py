from __future__ import annotations

from pathlib import Path
from threading import RLock


class GitStore:
    def __init__(self, root_dir: Path):
        self.root_dir = root_dir
        self.tracked_files = ["IDENTITY.md", "USER.md", "MEMORY.md"]
        self._lock = RLock()
        self._init_attempted = False

    def auto_commit(self, message: str) -> bool:
        with self._lock:
            try:
                repo = self._ensure_repo()
                if repo is None:
                    return False
                from dulwich.repo import Repo
                r: Repo = repo
                r.stage([self.root_dir / f for f in self.tracked_files if (self.root_dir / f).exists()])
                r.do_commit(message.encode("utf-8"), committer=b"agent-memory <memory@agent.local>")
                return True
            except Exception:
                return False

    def log(self, max_entries: int = 10) -> list[dict[str, str]]:
        try:
            repo = self._ensure_repo()
            if repo is None:
                return []
            from dulwich.repo import Repo
            r: Repo = repo
            entries = []
            for entry in r.get_walker(max_entries=max_entries):
                commit = entry.commit
                entries.append({
                    "sha": commit.id.decode("utf-8")[:8],
                    "message": commit.message.decode("utf-8", errors="replace"),
                    "author": commit.author.decode("utf-8", errors="replace"),
                    "time": str(commit.commit_time),
                })
            return entries
        except Exception:
            return []

    def revert(self, commit_sha: str) -> bool:
        with self._lock:
            try:
                repo = self._ensure_repo()
                if repo is None:
                    return False
                from dulwich.repo import Repo
                r: Repo = repo
                commit_id = bytes.fromhex(commit_sha)
                parent_tree = r[commit_id].tree if commit_id in r else None
                if parent_tree is None:
                    return False
                for filename in self.tracked_files:
                    filepath = self.root_dir / filename
                    if not filepath.exists():
                        continue
                    mode, sha = parent_tree[filename.encode("utf-8")]
                    filepath.write_bytes(r[sha].data)
                self.auto_commit(f"revert: restore memory state before {commit_sha[:8]}")
                return True
            except Exception:
                return False

    def line_ages(self, file_path: Path) -> list[tuple[str, int]]:
        try:
            repo = self._ensure_repo()
            if repo is None or not file_path.exists():
                return [(line, 0) for line in file_path.read_text(encoding="utf-8").splitlines()]
            from dulwich.repo import Repo
            r: Repo = repo
            return self._simple_blame(file_path)
        except Exception:
            return [(line, 0) for line in file_path.read_text(encoding="utf-8").splitlines()]

    def _ensure_repo(self):
        if self._init_attempted:
            try:
                from dulwich.repo import Repo
                return Repo(str(self.root_dir))
            except Exception:
                return None
        self._init_attempted = True
        try:
            from dulwich.repo import Repo
            try:
                return Repo(str(self.root_dir))
            except Exception:
                gitdir = self.root_dir / ".git"
                self.root_dir.mkdir(parents=True, exist_ok=True)
                try:
                    from dulwich.repo import Repo
                    repo = Repo.init(str(self.root_dir), mkdir=False)
                except TypeError:
                    gitdir.mkdir(parents=True, exist_ok=True)
                    repo = Repo.init_bare(str(gitdir))
                (self.root_dir / ".gitignore").write_text("*.jsonl\n.cursor\n.dream_cursor\n", encoding="utf-8")
                self.auto_commit("initial: agent memory store")
                return repo
        except Exception:
            return None

    def _simple_blame(self, file_path: Path) -> list[tuple[str, int]]:
        lines = file_path.read_text(encoding="utf-8").splitlines()
        result: list[tuple[str, int]] = []
        try:
            from dulwich.repo import Repo
            r = Repo(str(self.root_dir))
            log_entries = self.log(max_entries=5)
            for i, line in enumerate(lines):
                age = (len(log_entries) - min(i % (len(log_entries) or 1), len(log_entries) - 1)) * 7
                result.append((line, max(0, age)))
        except Exception:
            result = [(line, 0) for line in lines]
        return result
