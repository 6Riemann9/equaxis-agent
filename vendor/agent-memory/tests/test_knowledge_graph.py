from __future__ import annotations

import tempfile
from pathlib import Path
from datetime import datetime, timedelta

import pytest

from memory.config import MemoryConfig
from memory.store.knowledge_graph import KnowledgeGraphStore


class TestKnowledgeGraphStore:
    @pytest.fixture
    def kg(self):
        with tempfile.TemporaryDirectory() as tmp_:
            root = Path(tmp_) / "agent_test"
            yield KnowledgeGraphStore(MemoryConfig(root_dir=root))

    def test_add_entity(self, kg):
        entity = kg.add_entity("Kai", "person", {"role": "engineer"})
        assert entity.entity_id == "kai"
        assert entity.entity_type == "person"

    def test_add_triple(self, kg):
        kg.add_entity("Kai", "person")
        kg.add_entity("Orion", "project")
        triple = kg.add_triple("Kai", "works_on", "Orion", valid_from=datetime(2025, 6, 1), confidence=0.9)
        assert triple.subject == "kai"
        assert triple.predicate == "works_on"
        assert triple.object == "orion"
        assert triple.confidence == 0.9

    def test_invalidate(self, kg):
        kg.add_entity("Kai", "person")
        kg.add_entity("Voyager", "project")
        kg.add_triple("Kai", "works_on", "Voyager", valid_from=datetime(2024, 1, 1))
        kg.invalidate("Kai", "works_on", "Voyager", ended=datetime(2024, 12, 31))

        current = kg.query_entity("Kai")
        assert len(current) > 0
        for triple in current:
            if triple["predicate"] == "works_on" and triple["object"] == "voyager":
                assert triple["valid_to"] is not None

    def test_query_entity_as_of(self, kg):
        kg.add_entity("Kai", "person")
        kg.add_entity("Orion", "project")
        kg.add_entity("Voyager", "project")
        kg.add_triple("Kai", "works_on", "Orion", valid_from=datetime(2024, 1, 1), valid_to=datetime(2024, 12, 31))
        kg.add_triple("Kai", "works_on", "Voyager", valid_from=datetime(2025, 1, 1))

        mid_2024 = kg.query_entity("Kai", as_of=datetime(2024, 6, 1))
        orion_active = any(t["object"] == "orion" for t in mid_2024)
        assert orion_active

        mid_2025 = kg.query_entity("Kai", as_of=datetime(2025, 6, 1))
        voyager_active = any(t["object"] == "voyager" for t in mid_2025)
        assert voyager_active

    def test_query_relationship(self, kg):
        kg.add_entity("Kai", "person")
        kg.add_entity("Luna", "person")
        kg.add_entity("Orion", "project")
        kg.add_triple("Kai", "works_on", "Orion")
        kg.add_triple("Luna", "works_on", "Orion")

        results = kg.query_relationship("works_on")
        assert len(results) == 2

    def test_timeline(self, kg):
        kg.add_entity("Orion", "project")
        kg.add_entity("Kai", "person")
        kg.add_triple("Kai", "works_on", "Orion", valid_from=datetime(2023, 1, 1))
        kg.add_triple("Kai", "designed", "Orion", valid_from=datetime(2022, 6, 1))
        kg.add_triple("Orion", "status", "active", valid_from=datetime(2023, 1, 1))

        timeline = kg.timeline("Orion")
        assert len(timeline) >= 3

    def test_stats(self, kg):
        kg.add_entity("Kai", "person")
        kg.add_entity("Orion", "project")
        kg.add_triple("Kai", "works_on", "Orion")

        stats = kg.stats()
        assert stats["entities"] == 2
        assert stats["triples"] == 1
        assert stats["current_facts"] == 1

    def test_triple_id_is_stable_for_same_input(self):
        valid_from = datetime(2025, 6, 1)
        first = KnowledgeGraphStore._triple_id("Kai", "works_on", "Orion", valid_from)
        second = KnowledgeGraphStore._triple_id("Kai", "works_on", "Orion", valid_from)

        assert first == second
        assert first.startswith("t_")
        assert len(first) > 10

    def test_triple_id_is_stable_across_store_instances(self):
        with tempfile.TemporaryDirectory() as tmp_:
            root = Path(tmp_) / "agent_test"
            first_store = KnowledgeGraphStore(MemoryConfig(root_dir=root))
            first = first_store.add_triple("Kai", "works_on", "Orion", valid_from=datetime(2025, 6, 1))

            second_store = KnowledgeGraphStore(MemoryConfig(root_dir=root))
            second = second_store.add_triple("Kai", "works_on", "Orion", valid_from=datetime(2025, 6, 1))

            assert first.triple_id == second.triple_id
            assert second_store.stats()["triples"] == 1

    def test_different_triples_have_different_ids(self):
        first = KnowledgeGraphStore._triple_id("Kai", "works_on", "Orion", None)
        second = KnowledgeGraphStore._triple_id("Kai", "designed", "Orion", None)

        assert first != second

    def test_triple_id_has_no_separator_ambiguity(self):
        first = KnowledgeGraphStore._triple_id("a:b", "c", "d", None)
        second = KnowledgeGraphStore._triple_id("a", "b:c", "d", None)

        assert first != second

    def test_add_triple_reuses_legacy_natural_key_record(self, kg):
        kg.add_entity("Kai", "unknown")
        kg.add_entity("Orion", "unknown")
        with kg.connection() as conn:
            conn.execute(
                """
                INSERT INTO triples (
                    id, subject, predicate, object, valid_from, valid_to, confidence, metadata, extracted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("t_legacy", "kai", "works_on", "orion", None, None, 0.5, "{}", datetime(2025, 1, 1).isoformat()),
            )

        triple = kg.add_triple("Kai", "works_on", "Orion", confidence=0.9, metadata={"source": "new"})
        facts = kg.query_entity("Kai")

        assert triple.triple_id == "t_legacy"
        assert kg.stats()["triples"] == 1
        assert facts[0]["confidence"] == 0.9
        assert facts[0]["metadata"]["source"] == "new"
        assert "content_sha256" in facts[0]["metadata"]


class TestProvenanceAndGraphSearch:
    @pytest.fixture
    def kg(self):
        with tempfile.TemporaryDirectory() as tmp_:
            root = Path(tmp_) / "agent_test"
            yield KnowledgeGraphStore(MemoryConfig(root_dir=root))

    def test_add_triple_records_provenance(self, kg):
        triple = kg.add_triple(
            "Kai", "works_on", "Orion",
            source_ref="session-42", source_quote="Kai leads Orion now",
        )
        assert triple.metadata["source_ref"] == "session-42"
        assert triple.metadata["source_quote"] == "Kai leads Orion now"
        assert len(triple.metadata["content_sha256"]) == 64
        assert kg.verify_checksum(kg.query_entity("Kai")[0]) is True

    def test_add_triple_chains_previous_versions(self, kg):
        first = kg.add_triple("Kai", "role", "engineer", source_quote="v1")
        second = kg.add_triple("Kai", "role", "engineer", source_quote="v2")
        assert first.triple_id == second.triple_id
        meta = kg.query_entity("Kai")[0]["metadata"]
        assert len(meta["previous_versions"]) == 1
        assert meta["previous_versions"][0]["content_sha256"] == first.metadata["content_sha256"]
        assert meta["content_sha256"] != first.metadata["content_sha256"]

    def test_verify_checksum_detects_tampering(self, kg):
        kg.add_triple("Kai", "role", "engineer", source_quote="original")
        row = kg.query_entity("Kai")[0]
        row["metadata"]["source_quote"] = "tampered"
        assert kg.verify_checksum(row) is False
        report = kg.checksum_report("Kai")
        assert len(report) == 1
        assert report[0]["checksum_ok"] is True

    def test_conflict_detection_flags_different_objects(self, kg):
        kg.add_triple("Kai", "role", "engineer", source_ref="s1")
        conflicting = kg.add_triple("Kai", "role", "manager", source_ref="s2")
        assert conflicting.metadata["conflict_with"]
        conflicts = kg.detect_conflicts("Kai", "role")
        assert {c["object"] for c in conflicts} == {"engineer", "manager"}
        # re-adding the same (s, p, o) is a version update on the same row,
        # not a new conflict entry
        updated = kg.add_triple("Kai", "role", "manager", source_quote="v2")
        assert updated.triple_id == conflicting.triple_id
        assert len(updated.metadata["previous_versions"]) == 1
        assert len(kg.detect_conflicts("Kai", "role")) == 2

    def test_graph_search_multi_hop_with_decay(self, kg):
        for subject, predicate, object_name in [
            ("A", "links", "B"),
            ("B", "links", "C"),
            ("C", "links", "D"),
            ("E", "links", "F"),
        ]:
            kg.add_triple(subject, predicate, object_name)

        result = kg.graph_search(["A"], max_hops=2)
        names = {node["name"]: node for node in result["nodes"]}
        assert names["a"]["score"] == 1.0
        assert names["b"]["score"] == 0.5
        assert names["c"]["score"] == 0.25
        assert "d" not in names
        assert "e" not in names and "f" not in names

        deeper = kg.graph_search(["A"], max_hops=3)
        assert "d" in {node["name"] for node in deeper["nodes"]}

        cutoff = kg.graph_search(["A"], max_hops=3, min_score=0.4)
        assert {node["name"] for node in cutoff["nodes"]} == {"a", "b"}

        empty = kg.graph_search([])
        assert empty["nodes"] == [] and empty["visited"] == 0

    def test_graph_search_undirected_and_dedup(self, kg):
        kg.add_triple("A", "depends_on", "B")
        kg.add_triple("B", "depends_on", "C")
        # seed on the middle node reaches both directions
        result = kg.graph_search(["B"], max_hops=1)
        assert {node["name"] for node in result["nodes"]} == {"a", "b", "c"}
        assert result["visited"] == 3
