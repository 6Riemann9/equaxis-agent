from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from memory.config import MemoryConfig
from memory.store.long_term import LongTermMemoryStore
from memory.types import HallType


class TestLongTermMemoryStore:
    @pytest.fixture
    def store(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_:
            root = Path(tmp_) / "agent_test"
            yield LongTermMemoryStore(MemoryConfig(root_dir=root))

    def test_add_and_get_drawer(self, store):
        record = store.add_drawer(
            wing="wing-test",
            room="room-general",
            content="Our project uses PostgreSQL for data storage",
            source_file="docs/decisions.md",
            hall=HallType.FACTS,
        )
        assert record.wing == "wing-test"
        assert record.room == "room-general"

        retrieved = store.get_drawer(record.drawer_id)
        assert retrieved is not None
        assert retrieved.content == "Our project uses PostgreSQL for data storage"
        assert retrieved.hall == HallType.FACTS

    def test_delete_drawer(self, store):
        record = store.add_drawer(
            wing="wing-temp",
            room="room-temp",
            content="Temporary data",
            source_file="tmp.md",
        )
        store.delete_drawer(record.drawer_id)
        assert store.get_drawer(record.drawer_id) is None

    def test_search_by_wing_and_room(self, store):
        store.add_drawer(
            wing="wing-code",
            room="room-auth",
            content="Auth module uses JWT tokens with httpOnly cookies",
            source_file="auth.md",
        )
        store.add_drawer(
            wing="wing-code",
            room="room-auth",
            content="Token refresh mechanism uses sliding window expiry",
            source_file="auth.md",
        )
        store.add_drawer(
            wing="wing-code",
            room="room-api",
            content="GraphQL API uses Apollo Server with federation",
            source_file="api.md",
        )

        matches = store.search(query="JWT authentication", wing="wing-code", room="room-auth", limit=3)
        assert len(matches.matches) > 0

    def test_search_returns_content(self, store):
        store.add_drawer(
            wing="wing-code",
            room="room-db",
            content="We migrated from MySQL to PostgreSQL in Q3 2025",
            source_file="migration.md",
        )
        result = store.search(query="database migration", limit=3)
        assert len(result.matches) > 0
        assert any("PostgreSQL" in m.content for m in result.matches)

    def test_list_wings_and_rooms(self, store):
        store.add_drawer(wing="wing-alpha", room="room-1", content="Alpha one", source_file="a.md")
        store.add_drawer(wing="wing-alpha", room="room-2", content="Alpha two", source_file="a.md")
        store.add_drawer(wing="wing-beta", room="room-1", content="Beta one", source_file="b.md")

        wings = store.list_wings()
        assert "wing-alpha" in wings
        assert wings["wing-alpha"] == 2
        assert "wing-beta" in wings

        rooms = store.list_rooms("wing-alpha")
        assert "room-1" in rooms
        assert "room-2" in rooms

    def test_associative_search_expands_along_source_edges(self, store):
        """RippleMem 结构通道:锚点记忆的同源邻居被联想召回(带一跳惩罚)。

        场景构造:coffee 记忆不在锚点 top-k 内(被 3 条无关记忆挤到第 5 名),
        它只可能通过扩展边出现——而它的 source 不在任何锚点的结构边上,
        因此必须不被召回;nightly 记忆同样不在锚点内,但同源(ci.md)于
        锚点,必须被联想召回(证据补全)。
        """
        store.add_drawer(wing="wing-proj", room="room-general", content="Deploy pipeline uses GitHub Actions", source_file="ci.md")
        store.add_drawer(wing="wing-proj", room="room-general", content="The pipeline runs nightly at 3am", source_file="ci.md")
        store.add_drawer(wing="wing-proj", room="room-general", content="Team prefers coffee over tea", source_file="unrelated.md")
        for i in range(3):
            store.add_drawer(wing="wing-proj", room="room-general", content=f"Unrelated topic {i} about weather", source_file=f"weather{i}.md")

        # 锚点 top-k(limit=2, ×2)= 4 条:Deploy/nightly + 2 条 weather;coffee 排第 5 名,不在锚点内
        anchors = store.search(query="deploy pipeline", limit=2)
        assert "Deploy pipeline" in " ".join(m.content for m in anchors.matches)

        assoc = store.associative_search(query="deploy pipeline", limit=2)
        assoc_contents = " ".join(m.content for m in assoc.matches)
        assert "Deploy pipeline" in assoc_contents
        assert "nightly" in assoc_contents, "同源记忆应被联想召回(证据补全)"
        assert "coffee" not in assoc_contents, "无关源记忆不应被联想召回"

    def test_associative_search_keeps_anchor_priority(self, store):
        """扩展项带一跳惩罚:锚点仍排在前,联想项补充其后。"""
        store.add_drawer(wing="w", room="r", content="API rate limit is 100 per minute", source_file="api.md")
        store.add_drawer(wing="w", room="r", content="Rate limit resets every hour", source_file="api.md")
        store.add_drawer(wing="w", room="r", content="The sky looks blue today", source_file="sky.md")
        result = store.associative_search(query="API rate limit", limit=3)
        assert len(result.matches) >= 2
        # 首个匹配应为锚点(原始距离,无惩罚)
        assert "100 per minute" in result.matches[0].content


    def test_closet_add_and_search(self, store):
        d1 = store.add_drawer(wing="wing-xyz", room="room-main", content="Feature X ships in v2.0", source_file="roadmap.md")
        d2 = store.add_drawer(wing="wing-xyz", room="room-main", content="v2.0 includes GraphQL support", source_file="roadmap.md")
        store.add_closet(
            wing="wing-xyz",
            room="room-main",
            content="v2.0 roadmap|wing-xyz;room-main|→drawer_...",
            drawer_ids=[d1.drawer_id, d2.drawer_id],
        )
        result = store.search(query="v2.0 roadmap features", wing="wing-xyz", limit=5)
        assert len(result.matches) > 0

    def test_close_is_idempotent(self, store):
        store.close()
        store.close()
        store.close()

    def test_closet_boosts_staged_decay(self, store, monkeypatch):
        """分段衰减:full 内全额、full~cutoff 半额、cutoff 外零分。

        对应 SimGates (arXiv 2608.10216) 的教训:embedding 距离阈值
        在措辞变化下不可靠,硬边界会让边缘相关记忆在微小距离差上
        从满分跳到零分。这里验证加分是渐变的,而非二值。
        """

        def fake_query(query_texts, n_results, where):
            return {
                "ids": [["c1", "c2", "c3"]],
                "metadatas": [[{"source_file": "a.md"}, {"source_file": "b.md"}, {"source_file": "c.md"}]],
                "distances": [[0.5, 1.0, 1.6]],
            }

        monkeypatch.setattr(store.closets, "query", fake_query)
        boosts = store._closet_boosts(query="anything", wing="w", room="r")
        # rank0 全额 0.40;rank1 半额 0.125;rank2 超 cutoff 无加分
        assert boosts == {"a.md": 0.40, "b.md": 0.125}

    def test_closet_boosts_configurable_thresholds(self, store, monkeypatch):
        """cutoff/full 可从配置调整,默认 full=0.8、cutoff=1.5。"""
        cfg = store.config.long_term
        assert cfg.closet_boost_cutoff == 1.5
        assert cfg.closet_boost_full == 0.8

    def test_close_does_not_break_basic_lifecycle(self, store):
        record = store.add_drawer(
            wing="wing-close",
            room="room-lifecycle",
            content="Close should be safe after normal operations",
            source_file="lifecycle.md",
        )

        assert store.get_drawer(record.drawer_id) is not None
        store.close()
