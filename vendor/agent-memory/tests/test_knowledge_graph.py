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
        assert facts[0]["metadata"] == {"source": "new"}
