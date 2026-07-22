from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from memory.config import MemoryConfig
from memory.exceptions import KnowledgeGraphError
from memory.types import Entity, Triple


class KnowledgeGraphStore:
    def __init__(self, config: MemoryConfig):
        self.config = config
        try:
            self.config.root_dir.mkdir(parents=True, exist_ok=True)
            self._initialize()
        except Exception as e:
            raise KnowledgeGraphError(f"Failed to initialize knowledge graph: {e}") from e

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        try:
            conn = sqlite3.connect(self.config.knowledge_graph_path)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
                conn.commit()
            finally:
                conn.close()
        except sqlite3.Error as e:
            raise KnowledgeGraphError(f"Database connection error: {e}") from e

    def add_entity(self, name: str, entity_type: str, properties: dict[str, Any] | None = None) -> Entity:
        entity = Entity(entity_id=name.lower(), name=name, entity_type=entity_type, properties=properties or {})
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO entities (id, name, type, properties, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    type=excluded.type,
                    properties=excluded.properties
                """,
                (entity.entity_id, entity.name, entity.entity_type, json.dumps(entity.properties), entity.created_at.isoformat()),
            )
        return entity

    def add_triple(
        self,
        subject: str,
        predicate: str,
        object_name: str,
        *,
        valid_from: datetime | None = None,
        valid_to: datetime | None = None,
        confidence: float = 1.0,
        metadata: dict[str, Any] | None = None,
    ) -> Triple:
        self.add_entity(subject, "unknown")
        self.add_entity(object_name, "unknown")
        subject_id = subject.lower()
        predicate_id = predicate.lower()
        object_id = object_name.lower()
        valid_from_value = valid_from.isoformat() if valid_from else None
        with self.connection() as conn:
            triple_id = self._find_existing_triple_id(conn, subject_id, predicate_id, object_id, valid_from_value)
            if triple_id is None:
                triple_id = self._triple_id(subject, predicate, object_name, valid_from)
            triple = Triple(
                triple_id=triple_id,
                subject=subject_id,
                predicate=predicate_id,
                object=object_id,
                valid_from=valid_from,
                valid_to=valid_to,
                confidence=confidence,
                metadata=metadata or {},
            )
            conn.execute(
                """
                INSERT INTO triples (
                    id, subject, predicate, object, valid_from, valid_to, confidence, metadata, extracted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    valid_to=excluded.valid_to,
                    confidence=excluded.confidence,
                    metadata=excluded.metadata
                """,
                (
                    triple.triple_id,
                    triple.subject,
                    triple.predicate,
                    triple.object,
                    valid_from_value,
                    triple.valid_to.isoformat() if triple.valid_to else None,
                    triple.confidence,
                    json.dumps(triple.metadata),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
        return triple

    def invalidate(self, subject: str, predicate: str, object_name: str, ended: datetime | None = None) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                UPDATE triples
                SET valid_to = ?
                WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
                """,
                ((ended or datetime.now(timezone.utc)).isoformat(), subject.lower(), predicate.lower(), object_name.lower()),
            )

    def query_entity(self, name: str, as_of: datetime | None = None, direction: str = "outgoing") -> list[dict[str, Any]]:
        clauses = []
        params: list[Any] = []
        target = name.lower()
        if direction == "incoming":
            clauses.append("object = ?")
            params.append(target)
        elif direction == "both":
            clauses.append("(subject = ? OR object = ?)")
            params.extend([target, target])
        else:
            clauses.append("subject = ?")
            params.append(target)
        if as_of is not None:
            point = as_of.isoformat()
            clauses.append("(valid_from IS NULL OR valid_from <= ?)")
            clauses.append("(valid_to IS NULL OR valid_to >= ?)")
            params.extend([point, point])
        query = "SELECT * FROM triples WHERE " + " AND ".join(clauses) + " ORDER BY COALESCE(valid_from, extracted_at)"
        with self.connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def query_relationship(self, predicate: str, as_of: datetime | None = None) -> list[dict[str, Any]]:
        clauses = ["predicate = ?"]
        params: list[Any] = [predicate.lower()]
        if as_of is not None:
            point = as_of.isoformat()
            clauses.append("(valid_from IS NULL OR valid_from <= ?)")
            clauses.append("(valid_to IS NULL OR valid_to >= ?)")
            params.extend([point, point])
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM triples WHERE " + " AND ".join(clauses) + " ORDER BY COALESCE(valid_from, extracted_at)",
                params,
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def timeline(self, name: str) -> list[dict[str, Any]]:
        return self.query_entity(name, direction="both")

    def stats(self) -> dict[str, int]:
        with self.connection() as conn:
            entities = conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
            triples = conn.execute("SELECT COUNT(*) FROM triples").fetchone()[0]
            current_facts = conn.execute("SELECT COUNT(*) FROM triples WHERE valid_to IS NULL").fetchone()[0]
        return {"entities": entities, "triples": triples, "current_facts": current_facts}

    def _initialize(self) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS entities (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    properties TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS triples (
                    id TEXT PRIMARY KEY,
                    subject TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    object TEXT NOT NULL,
                    valid_from TEXT,
                    valid_to TEXT,
                    confidence REAL NOT NULL,
                    metadata TEXT NOT NULL,
                    extracted_at TEXT NOT NULL,
                    FOREIGN KEY(subject) REFERENCES entities(id),
                    FOREIGN KEY(object) REFERENCES entities(id)
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate)")

    @staticmethod
    def _find_existing_triple_id(
        conn: sqlite3.Connection, subject: str, predicate: str, object_name: str, valid_from: str | None
    ) -> str | None:
        cursor = conn.execute(
            """
            SELECT id FROM triples
            WHERE subject = ?
              AND predicate = ?
              AND object = ?
              AND COALESCE(valid_from, '') = COALESCE(?, '')
            LIMIT 1
            """,
            (subject, predicate, object_name, valid_from),
        )
        row = cursor.fetchone()
        return row[0] if row else None

    @staticmethod
    def _triple_id(subject: str, predicate: str, object_name: str, valid_from: datetime | None) -> str:
        base = json.dumps(
            [
                subject.casefold(),
                predicate.casefold(),
                object_name.casefold(),
                valid_from.isoformat() if valid_from else None,
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        digest = hashlib.sha256(base.encode("utf-8")).hexdigest()[:24]
        return f"t_{digest}"

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        payload = dict(row)
        payload["metadata"] = json.loads(payload["metadata"])
        return payload
