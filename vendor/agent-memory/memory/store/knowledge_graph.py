from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import deque
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
        source_ref: str = "",
        source_quote: str = "",
        content_sha256: str | None = None,
    ) -> Triple:
        self.add_entity(subject, "unknown")
        self.add_entity(object_name, "unknown")
        subject_id = subject.lower()
        predicate_id = predicate.lower()
        object_id = object_name.lower()
        valid_from_value = valid_from.isoformat() if valid_from else None
        # Semantica-style provenance: every fact carries its source, a verbatim
        # source quote and a content checksum so tampering is detectable and
        # version history is traceable (fact-level PROV-O minimal slice).
        checksum = content_sha256 or self.fact_checksum(subject_id, predicate_id, object_id, valid_from_value, source_quote)
        meta = dict(metadata or {})
        meta.setdefault("source_ref", source_ref)
        meta.setdefault("source_quote", source_quote)
        meta.setdefault("content_sha256", checksum)
        with self.connection() as conn:
            triple_id = self._find_existing_triple_id(conn, subject_id, predicate_id, object_id, valid_from_value)
            if triple_id is None:
                triple_id = self._triple_id(subject, predicate, object_name, valid_from)
            # Version chaining: re-tracking the same (s,p,o) appends the
            # previous generation to previous_versions instead of losing it.
            existing = conn.execute("SELECT metadata, extracted_at FROM triples WHERE id = ?", (triple_id,)).fetchone()
            if existing is not None:
                old_meta = json.loads(existing["metadata"])
                previous = list(old_meta.get("previous_versions", []))
                previous.append({"content_sha256": old_meta.get("content_sha256"), "extracted_at": existing["extracted_at"]})
                meta["previous_versions"] = previous[-10:]
            # Conflict detection: same (subject, predicate) with a different
            # object is flagged, never silently overwritten.
            conflicts = self._conflicts_locked(conn, subject_id, predicate_id, object_id, exclude_id=triple_id)
            if conflicts:
                meta["conflict_with"] = [row["id"] for row in conflicts]
            triple = Triple(
                triple_id=triple_id,
                subject=subject_id,
                predicate=predicate_id,
                object=object_id,
                valid_from=valid_from,
                valid_to=valid_to,
                confidence=confidence,
                metadata=meta,
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

    @staticmethod
    def _conflicts_locked(
        conn: sqlite3.Connection, subject_id: str, predicate_id: str, object_id: str, exclude_id: str | None = None
    ) -> list[dict[str, Any]]:
        clauses = ["subject = ?", "predicate = ?", "object != ?", "valid_to IS NULL"]
        params: list[Any] = [subject_id, predicate_id, object_id]
        if exclude_id is not None:
            clauses.append("id != ?")
            params.append(exclude_id)
        rows = conn.execute(
            "SELECT id, subject, predicate, object, valid_from, valid_to, confidence, metadata, extracted_at FROM triples WHERE "
            + " AND ".join(clauses),
            params,
        ).fetchall()
        return [dict(row) for row in rows]

    def detect_conflicts(self, subject: str, predicate: str) -> list[dict[str, Any]]:
        """Current facts with the same (subject, predicate) but different objects."""
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM triples WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY COALESCE(valid_from, extracted_at)",
                (subject.lower(), predicate.lower()),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def fact_checksum(subject: str, predicate: str, object_name: str, valid_from: str | None = None, source_quote: str = "") -> str:
        """Content-addressed checksum for a fact (subject|predicate|object|valid_from|quote)."""
        payload = "|".join([str(subject), str(predicate), str(object_name), str(valid_from or ""), str(source_quote)])
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def verify_checksum(self, row: dict[str, Any]) -> bool:
        """Tamper check: recompute the checksum from the row and compare."""
        metadata = row.get("metadata") or {}
        stored = metadata.get("content_sha256")
        if not stored:
            return False
        expected = self.fact_checksum(
            row["subject"], row["predicate"], row["object"], row.get("valid_from"), metadata.get("source_quote", "")
        )
        return stored == expected

    def checksum_report(self, name: str) -> list[dict[str, Any]]:
        rows = self.query_entity(name, direction="both")
        return [{**row, "checksum_ok": self.verify_checksum(row)} for row in rows]

    def graph_search(
        self,
        seeds: list[str],
        max_hops: int = 2,
        hop_decay: float = 0.5,
        min_score: float = 0.05,
        max_nodes: int = 100,
    ) -> dict[str, Any]:
        """Multi-hop graph retrieval (TencentDB wiki graph-search analog):
        BFS over current facts from seed entities, undirected, with per-hop
        score decay, a hard visited-node cap and a min-score cutoff."""
        seed_names = [str(seed).strip().lower() for seed in (seeds or []) if str(seed).strip()]
        if not seed_names:
            return {"nodes": [], "edges": [], "visited": 0}
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM triples WHERE valid_to IS NULL").fetchall()
        triples = [self._row_to_dict(row) for row in rows]
        by_name: dict[str, list[dict[str, Any]]] = {}
        for triple in triples:
            by_name.setdefault(triple["subject"], []).append(triple)
            by_name.setdefault(triple["object"], []).append(triple)

        visited: dict[str, dict[str, Any]] = {}
        edges: list[dict[str, Any]] = []
        queue: deque[tuple[str, int]] = deque((name, 0) for name in seed_names)
        while queue and len(visited) < max_nodes:
            name, depth = queue.popleft()
            if name in visited or depth > max_hops:
                continue
            score = hop_decay**depth
            if score < min_score:
                continue
            visited[name] = {"name": name, "score": round(score, 4), "depth": depth}
            for triple in by_name.get(name, []):
                edges.append(
                    {
                        "from": triple["subject"],
                        "predicate": triple["predicate"],
                        "to": triple["object"],
                        "depth": depth + 1,
                    }
                )
                neighbor = triple["object"] if triple["subject"] == name else triple["subject"]
                if neighbor not in visited:
                    queue.append((neighbor, depth + 1))
        edges = edges[: max_nodes * 8]
        return {
            "nodes": sorted(visited.values(), key=lambda node: (-node["score"], node["name"])),
            "edges": sorted(edges, key=lambda edge: (edge["depth"], edge["from"], edge["predicate"])),
            "visited": len(visited),
        }

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
