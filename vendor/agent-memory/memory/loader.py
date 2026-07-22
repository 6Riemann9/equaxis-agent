from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .config import MemoryConfig, build_default_config


class ConfigLoader:
    def __init__(self, root_dir: str | Path):
        self.root_dir = Path(root_dir).resolve()
        self.config_path = self.root_dir / "memory.config.json"

    def load(self) -> MemoryConfig:
        config = build_default_config(self.root_dir)
        if not self.config_path.exists():
            return config
        payload = json.loads(self.config_path.read_text(encoding="utf-8"))
        self._apply(config, payload)
        return config

    def save(self, config: MemoryConfig) -> None:
        self.config_path.write_text(
            json.dumps(self._serialize(config), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def initialize_layout(self, config: MemoryConfig | None = None) -> MemoryConfig:
        current = config or self.load()
        current.root_dir.mkdir(parents=True, exist_ok=True)
        current.history_dir.mkdir(parents=True, exist_ok=True)
        current.long_term_dir.mkdir(parents=True, exist_ok=True)
        current.skills_path.mkdir(parents=True, exist_ok=True)
        for path, default_text in (
            (current.identity_path, "# Identity\n"),
            (current.user_path, "# User\n"),
            (current.memory_path, "# Memory\n"),
            (current.history_path, ""),
            (current.cursor_path, "0\n"),
            (current.dream_cursor_path, "0\n"),
        ):
            if not path.exists():
                path.write_text(default_text, encoding="utf-8")
        if not self.config_path.exists():
            # Save with version information
            from memory.config_validator import save_config_with_version
            save_config_with_version(current, self.config_path)
        return current

    def _apply(self, config: MemoryConfig, payload: dict) -> None:
        if "max_history_entries" in payload:
            config.max_history_entries = int(payload["max_history_entries"])
        if "recent_history_limit" in payload:
            config.recent_history_limit = int(payload["recent_history_limit"])
        if "recent_history_char_limit" in payload:
            config.recent_history_char_limit = int(payload["recent_history_char_limit"])
        dream = payload.get("dream", {})
        for key in ("interval_hours", "model_override", "max_batch_size", "max_iterations", "annotate_line_ages"):
            if key in dream:
                setattr(config.dream, key, dream[key])
        consolidation = payload.get("consolidation", {})
        for key in (
            "context_window_tokens",
            "max_completion_tokens",
            "consolidation_ratio",
            "safety_buffer_tokens",
            "archive_summary_max_chars",
            "raw_archive_max_chars",
            "history_entry_hard_cap",
        ):
            if key in consolidation:
                setattr(config.consolidation, key, consolidation[key])
        long_term = payload.get("long_term", {})
        for key in ("collection_name", "closet_collection_name", "embedding_model", "chroma_subdir"):
            if key in long_term:
                setattr(config.long_term, key, long_term[key])
        knowledge_graph = payload.get("knowledge_graph", {})
        if "sqlite_filename" in knowledge_graph:
            config.knowledge_graph.sqlite_filename = knowledge_graph["sqlite_filename"]

    def _serialize(self, config: MemoryConfig) -> dict:
        payload = asdict(config)
        payload["root_dir"] = str(config.root_dir)
        payload["saved_at"] = datetime.now(timezone.utc).isoformat()
        return payload
