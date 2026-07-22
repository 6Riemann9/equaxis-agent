from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(slots=True)
class DreamConfig:
    interval_hours: int = 2
    model_override: str | None = None
    max_batch_size: int = 20
    max_iterations: int = 15
    annotate_line_ages: bool = True


@dataclass(slots=True)
class ConsolidationConfig:
    context_window_tokens: int = 65536
    max_completion_tokens: int = 8192
    consolidation_ratio: float = 0.5
    safety_buffer_tokens: int = 1024
    archive_summary_max_chars: int = 8000
    raw_archive_max_chars: int = 16000
    history_entry_hard_cap: int = 64000


@dataclass(slots=True)
class LongTermConfig:
    collection_name: str = "agent_memory_drawers"
    closet_collection_name: str = "agent_memory_closets"
    embedding_model: str = "all-MiniLM-L6-v2"
    chroma_subdir: str = "palace"


@dataclass(slots=True)
class KnowledgeGraphConfig:
    sqlite_filename: str = "knowledge_graph.sqlite3"


@dataclass(slots=True)
class MemoryConfig:
    root_dir: Path
    max_history_entries: int = 1000
    recent_history_limit: int = 50
    recent_history_char_limit: int = 32000
    identity_filename: str = "IDENTITY.md"
    user_filename: str = "USER.md"
    memory_filename: str = "MEMORY.md"
    skills_dirname: str = "skills"
    history_dirname: str = "history"
    history_filename: str = "history.jsonl"
    cursor_filename: str = ".cursor"
    dream_cursor_filename: str = ".dream_cursor"
    dream: DreamConfig = field(default_factory=DreamConfig)
    consolidation: ConsolidationConfig = field(default_factory=ConsolidationConfig)
    long_term: LongTermConfig = field(default_factory=LongTermConfig)
    knowledge_graph: KnowledgeGraphConfig = field(default_factory=KnowledgeGraphConfig)

    @property
    def history_dir(self) -> Path:
        return self.root_dir / self.history_dirname

    @property
    def history_path(self) -> Path:
        return self.history_dir / self.history_filename

    @property
    def cursor_path(self) -> Path:
        return self.history_dir / self.cursor_filename

    @property
    def dream_cursor_path(self) -> Path:
        return self.history_dir / self.dream_cursor_filename

    @property
    def long_term_dir(self) -> Path:
        return self.root_dir / "long_term"

    @property
    def chroma_path(self) -> Path:
        return self.long_term_dir / self.long_term.chroma_subdir

    @property
    def knowledge_graph_path(self) -> Path:
        return self.root_dir / self.knowledge_graph.sqlite_filename

    @property
    def identity_path(self) -> Path:
        return self.root_dir / self.identity_filename

    @property
    def user_path(self) -> Path:
        return self.root_dir / self.user_filename

    @property
    def memory_path(self) -> Path:
        return self.root_dir / self.memory_filename

    @property
    def skills_path(self) -> Path:
        return self.root_dir / self.skills_dirname


def build_default_config(root_dir: str | Path) -> MemoryConfig:
    return MemoryConfig(root_dir=Path(root_dir).resolve())
