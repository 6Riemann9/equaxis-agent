from __future__ import annotations

from dataclasses import dataclass

from memory.store.manager import MemoryManager


@dataclass(slots=True)
class MemoryLayers:
    l0: str
    l1: str
    l2: str
    l3: str


class MemoryStack:
    def __init__(self, manager: MemoryManager):
        self.manager = manager

    def wake_up(self, wing: str | None = None) -> str:
        parts = [self._load_identity(), self._load_essential_story(wing=wing)]
        return "\n\n".join(part for part in parts if part)

    def recall(self, wing: str | None = None, room: str | None = None, limit: int = 5) -> str:
        results = self.manager.search(query=room or wing or "general", wing=wing, room=room, limit=limit)
        return self._format_results(results)

    def search(self, query: str, wing: str | None = None, room: str | None = None, limit: int = 5) -> str:
        results = self.manager.search(query=query, wing=wing, room=room, limit=limit)
        return self._format_results(results)

    def status(self) -> dict:
        return {
            "wings": self.manager.long_term.list_wings(),
            "knowledge_graph": self.manager.knowledge_graph.stats(),
        }

    def compose_layers(self, topic: str | None = None, wing: str | None = None, room: str | None = None) -> MemoryLayers:
        l0 = self._load_identity()
        l1 = self._load_essential_story(wing=wing)
        l2 = self.recall(wing=wing, room=room) if wing or room else ""
        l3 = self.search(query=topic, wing=wing, room=room) if topic else ""
        return MemoryLayers(l0=l0, l1=l1, l2=l2, l3=l3)

    def _load_identity(self) -> str:
        if self.manager.config.identity_path.exists():
            return self.manager.config.identity_path.read_text(encoding="utf-8").strip()
        return ""

    def _load_essential_story(self, wing: str | None = None) -> str:
        wings = self.manager.long_term.list_wings()
        if wing and wing not in wings:
            return ""
        chosen_wing = wing or next(iter(wings), None)
        if not chosen_wing:
            return ""
        rooms = self.manager.long_term.list_rooms(chosen_wing)
        parts = []
        for room_name in list(rooms.keys())[:3]:
            results = self.manager.search(query=room_name, wing=chosen_wing, room=room_name, limit=2)
            parts.append(self._format_results(results))
        return "\n\n".join(part for part in parts if part)

    @staticmethod
    def _format_results(results) -> str:
        blocks = []
        for match in results.matches:
            blocks.append(f"[{match.metadata.get('wing', '')}/{match.metadata.get('room', '')}] {match.content}")
        return "\n".join(blocks)
