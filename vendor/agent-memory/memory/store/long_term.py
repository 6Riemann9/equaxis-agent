from __future__ import annotations

import hashlib
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import chromadb
from chromadb.api.models.Collection import Collection
from chromadb.utils import embedding_functions

from memory.config import MemoryConfig
from memory.exceptions import SearchError, StorageError
from memory.types import ClosetRecord, DrawerRecord, HallType, QueryMatch, QueryResult


class LongTermMemoryStore:
    def __init__(self, config: MemoryConfig):
        self.config = config
        try:
            self.config.chroma_path.mkdir(parents=True, exist_ok=True)
            self.client = chromadb.PersistentClient(path=str(self.config.chroma_path))
            # Pin the embedding function only when creating a new collection:
            # Chroma stores the embedding-function identity on the collection and
            # rejects a different one on existing stores. The configured model is
            # still validated up front so unsupported values fail fast.
            existing = {collection.name for collection in self.client.list_collections()}
            drawer_ef = self._embedding_function() if self.config.long_term.collection_name not in existing else None
            closet_ef = self._embedding_function() if self.config.long_term.closet_collection_name not in existing else None
            self.drawers = self.client.get_or_create_collection(
                name=self.config.long_term.collection_name,
                embedding_function=drawer_ef,
            )
            self.closets = self.client.get_or_create_collection(
                name=self.config.long_term.closet_collection_name,
                embedding_function=closet_ef,
            )
        except Exception as e:
            raise StorageError(f"Failed to initialize long-term memory store: {e}") from e

    def _embedding_function(self):
        """Resolve the configured embedding model to a Chroma embedding function.

        Chroma's implicit default is all-MiniLM-L6-v2 (ONNX); pinning it here
        makes the dependency explicit, configurable, and fail-fast on unsupported
        values instead of silently shipping a different model.
        """
        model = (self.config.long_term.embedding_model or "all-MiniLM-L6-v2").strip().lower()
        if model in ("all-minilm-l6-v2", "default", ""):
            return embedding_functions.ONNXMiniLM_L6_V2()
        raise StorageError(
            f"Unsupported long_term.embedding_model: {self.config.long_term.embedding_model} "
            "(supported: all-MiniLM-L6-v2)"
        )

    def add_drawer(
        self,
        wing: str,
        room: str,
        content: str,
        source_file: str,
        hall: HallType = HallType.GENERAL,
        metadata: dict[str, Any] | None = None,
        added_by: str = "agent-memory",
    ) -> DrawerRecord:
        drawer_id = self._build_drawer_id(wing, room, content)
        record = DrawerRecord(
            drawer_id=drawer_id,
            wing=wing,
            room=room,
            hall=hall,
            content=content,
            source_file=source_file,
            added_by=added_by,
            metadata=metadata or {},
        )
        self.drawers.upsert(
            ids=[drawer_id],
            documents=[content],
            metadatas=[self._drawer_metadata(record)],
        )
        return record

    def add_closet(
        self,
        wing: str,
        room: str,
        content: str,
        drawer_ids: list[str],
        metadata: dict[str, Any] | None = None,
    ) -> ClosetRecord:
        closet_id = self._build_closet_id(wing, room, content)
        record = ClosetRecord(
            closet_id=closet_id,
            wing=wing,
            room=room,
            content=content,
            drawer_ids=drawer_ids,
            metadata=metadata or {},
        )
        self.closets.upsert(
            ids=[closet_id],
            documents=[content],
            metadatas=[self._closet_metadata(record)],
        )
        return record

    def search(
        self,
        query: str,
        wing: str | None = None,
        room: str | None = None,
        limit: int = 5,
    ) -> QueryResult:
        try:
            where = self._build_where(wing=wing, room=room)
            result = self.drawers.query(query_texts=[query], n_results=max(limit * 3, limit), where=where)
            matches = self._matches_from_query(result)
            closet_boosts = self._closet_boosts(query, wing=wing, room=room)
            rescored = []
            for match in matches:
                source = str(match.metadata.get("source_file", ""))
                boost = closet_boosts.get(source, 0.0)
                rescored.append(QueryMatch(id=match.id, content=match.content, metadata=match.metadata, score=max(0.0, match.score - boost)))
            rescored.sort(key=lambda item: item.score)
            return QueryResult(matches=rescored[:limit])
        except Exception as e:
            raise SearchError(f"Search failed: {e}") from e

    def get_drawer(self, drawer_id: str) -> DrawerRecord | None:
        payload = self.drawers.get(ids=[drawer_id])
        if not payload["ids"]:
            return None
        metadata = payload["metadatas"][0]
        return DrawerRecord(
            drawer_id=payload["ids"][0],
            wing=metadata["wing"],
            room=metadata["room"],
            hall=HallType(metadata["hall"]),
            content=payload["documents"][0],
            source_file=metadata["source_file"],
            chunk_index=int(metadata.get("chunk_index", 0)),
            added_by=metadata.get("added_by", "agent-memory"),
            filed_at=datetime.fromisoformat(metadata["filed_at"]),
            metadata=self._extra_metadata(metadata),
        )

    def delete_drawer(self, drawer_id: str) -> None:
        self.drawers.delete(ids=[drawer_id])

    def update_drawer(
        self,
        drawer_id: str,
        content: str | None = None,
        wing: str | None = None,
        room: str | None = None,
        hall: HallType | None = None,
        source_file: str | None = None,
        metadata: dict[str, Any] | None = None,
        added_by: str | None = None,
    ) -> DrawerRecord | None:
        """Update an existing drawer in place, preserving its id.

        Fields left as ``None`` keep their current value. Returns ``None``
        when no drawer with ``drawer_id`` exists.
        """
        existing = self.get_drawer(drawer_id)
        if existing is None:
            return None
        record = DrawerRecord(
            drawer_id=drawer_id,
            wing=wing if wing is not None else existing.wing,
            room=room if room is not None else existing.room,
            hall=hall if hall is not None else existing.hall,
            content=content if content is not None else existing.content,
            source_file=source_file if source_file is not None else existing.source_file,
            chunk_index=existing.chunk_index,
            added_by=added_by if added_by is not None else existing.added_by,
            filed_at=existing.filed_at,
            metadata={**existing.metadata, **(metadata or {})},
        )
        self.drawers.upsert(
            ids=[drawer_id],
            documents=[record.content],
            metadatas=[self._drawer_metadata(record)],
        )
        return record

    def list_wings(self) -> dict[str, int]:
        payload = self.drawers.get(include=["metadatas"])
        counts: dict[str, int] = {}
        for metadata in payload.get("metadatas", []):
            wing = metadata["wing"]
            counts[wing] = counts.get(wing, 0) + 1
        return counts

    def list_rooms(self, wing: str) -> dict[str, int]:
        payload = self.drawers.get(where={"wing": wing}, include=["metadatas"])
        counts: dict[str, int] = {}
        for metadata in payload.get("metadatas", []):
            room = metadata["room"]
            counts[room] = counts.get(room, 0) + 1
        return counts

    def build_closet_lines(self, wing: str, room: str, drawers: list[DrawerRecord]) -> list[str]:
        groups: dict[str, list[str]] = {}
        for drawer in drawers:
            topic = self._extract_topic(drawer.content)
            groups.setdefault(topic, []).append(drawer.drawer_id)
        lines = []
        for topic, drawer_ids in groups.items():
            line = f"{topic}|{wing};{room}|→{','.join(drawer_ids)}"
            lines.append(line[:1500])
        return lines

    def _closet_boosts(self, query: str, wing: str | None, room: str | None) -> dict[str, float]:
        result = self.closets.query(query_texts=[query], n_results=5, where=self._build_where(wing=wing, room=room))
        boosts: dict[str, float] = {}
        distances = result.get("distances") or [[]]
        for index, metadata in enumerate((result.get("metadatas") or [[]])[0]):
            rank_boost = [0.40, 0.25, 0.15, 0.08, 0.04][index] if index < 5 else 0.0
            distance = distances[0][index] if distances and distances[0] else 0.0
            if distance > 1.5:
                continue
            source = metadata.get("source_file")
            if source:
                boosts[source] = max(boosts.get(source, 0.0), rank_boost)
        return boosts

    def _matches_from_query(self, result: dict) -> list[QueryMatch]:
        ids = result.get("ids") or [[]]
        documents = result.get("documents") or [[]]
        metadatas = result.get("metadatas") or [[]]
        distances = result.get("distances") or [[]]
        matches: list[QueryMatch] = []
        for idx, match_id in enumerate(ids[0] if ids else []):
            matches.append(
                QueryMatch(
                    id=match_id,
                    content=documents[0][idx],
                    metadata=metadatas[0][idx],
                    score=float(distances[0][idx]) if distances and distances[0] else 0.0,
                )
            )
        return matches

    @staticmethod
    def _build_drawer_id(wing: str, room: str, content: str) -> str:
        digest = hashlib.sha256(f"{wing}:{room}:{content}".encode("utf-8")).hexdigest()[:24]
        return f"drawer_{wing}_{room}_{digest}"

    @staticmethod
    def _build_closet_id(wing: str, room: str, content: str) -> str:
        digest = hashlib.sha256(f"closet:{wing}:{room}:{content}".encode("utf-8")).hexdigest()[:24]
        return f"closet_{wing}_{room}_{digest}"

    @staticmethod
    def _extract_topic(content: str) -> str:
        text = " ".join(content.strip().split())
        if not text:
            return "general"
        return text[:80]

    def _build_where(self, wing: str | None, room: str | None) -> dict | None:
        clauses = []
        if wing:
            clauses.append({"wing": wing})
        if room:
            clauses.append({"room": room})
        if not clauses:
            return None
        if len(clauses) == 1:
            return clauses[0]
        return {"$and": clauses}

    @staticmethod
    def _extra_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
        system_keys = {"wing", "room", "hall", "source_file", "chunk_index", "added_by", "filed_at"}
        return {key: value for key, value in metadata.items() if key not in system_keys}

    @staticmethod
    def _drawer_metadata(record: DrawerRecord) -> dict[str, Any]:
        metadata = {
            "wing": record.wing,
            "room": record.room,
            "hall": record.hall.value,
            "source_file": record.source_file,
            "chunk_index": record.chunk_index,
            "added_by": record.added_by,
            "filed_at": record.filed_at.isoformat(),
        }
        metadata.update(record.metadata)
        return metadata

    @staticmethod
    def _closet_metadata(record: ClosetRecord) -> dict[str, Any]:
        metadata = {
            "wing": record.wing,
            "room": record.room,
            "source_file": "closet",
            "drawer_ids": ",".join(record.drawer_ids),
            "filed_at": datetime.now(timezone.utc).isoformat(),
        }
        metadata.update(record.metadata)
        return metadata

    def close(self) -> None:
        """Best-effort, idempotent cleanup for the ChromaDB client."""
        try:
            self.client.clear_system_cache()
        except Exception:
            pass
