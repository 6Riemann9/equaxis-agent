from __future__ import annotations

from memory.stack.layers import MemoryStack
from memory.store.manager import MemoryManager
from memory.types import Message, MessageRole


class ContextBuilder:
    def __init__(self, manager: MemoryManager):
        self.manager = manager
        self.stack = MemoryStack(manager)

    def build_system_prompt(self, topic: str | None = None, wing: str | None = None, room: str | None = None) -> str:
        layers = self.stack.compose_layers(topic=topic, wing=wing, room=room)
        durable = self.manager.durable_memory_text()
        history = self.manager.recent_history_text()
        sections = [
            layers.l0,
            layers.l1,
            durable,
            layers.l2,
            layers.l3,
            history,
        ]
        return "\n\n".join(section for section in sections if section)

    def build_messages(
        self,
        session_id: str,
        user_message: str,
        *,
        topic: str | None = None,
        wing: str | None = None,
        room: str | None = None,
    ) -> list[dict[str, str]]:
        session = self.manager.short_term.get_or_create_session(session_id)
        messages = [{"role": "system", "content": self.build_system_prompt(topic=topic, wing=wing, room=room)}]
        for item in session.messages:
            messages.append({"role": item.role.value, "content": item.content})
        messages.append({"role": "user", "content": user_message})
        return messages

    def record_user_message(self, session_id: str, user_message: str) -> None:
        self.manager.append_message(session_id, Message(role=MessageRole.USER, content=user_message))
        self.manager.archive_text(session_id, f"[user] {user_message}")

    def record_assistant_message(self, session_id: str, assistant_message: str) -> None:
        self.manager.append_message(session_id, Message(role=MessageRole.ASSISTANT, content=assistant_message))
        self.manager.archive_text(session_id, f"[assistant] {assistant_message}")
