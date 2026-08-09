from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any


RESPONSE_PREFIX = "__EQUAXIS_MEMORY__"


def configure_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


configure_stdio()

PROJECT_ROOT = Path(__file__).resolve().parents[1]
VENDORED_MEMORY = PROJECT_ROOT / "vendor" / "agent-memory"
sys.path.insert(0, str(VENDORED_MEMORY))

from memory import AgentMemory, HallType  # noqa: E402


def clean_surrogates(value: Any) -> Any:
    if is_dataclass(value):
        return clean_surrogates(asdict(value))
    if isinstance(value, Enum):
        return clean_surrogates(value.value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, str):
        return "".join("\ufffd" if 0xD800 <= ord(char) <= 0xDFFF else char for char in value)
    if isinstance(value, list):
        return [clean_surrogates(item) for item in value]
    if isinstance(value, tuple):
        return [clean_surrogates(item) for item in value]
    if isinstance(value, dict):
        return {clean_surrogates(key): clean_surrogates(item) for key, item in value.items()}
    if isinstance(value, set):
        return sorted(clean_surrogates(item) for item in value)
    return value


def json_default(value: Any) -> Any:
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, set):
        return sorted(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def emit(request_id: str | None, *, result: Any = None, error: Exception | None = None) -> None:
    if error is None:
        payload = {"id": request_id, "ok": True, "result": clean_surrogates(result)}
    else:
        payload = {
            "id": request_id,
            "ok": False,
            "error": {"type": type(error).__name__, "message": clean_surrogates(str(error))},
        }
    line = json.dumps(clean_surrogates(payload), ensure_ascii=True, default=json_default)
    print(f"{RESPONSE_PREFIX}{line}", flush=True)


def format_matches(result: Any) -> list[dict[str, Any]]:
    return [
        {
            "id": match.id,
            "content": match.content,
            "metadata": match.metadata,
            "score": match.score,
        }
        for match in result.matches
    ]


def build_memory_context(memory: AgentMemory, payload: dict[str, Any]) -> str:
    query = str(payload.get("query", "")).strip()
    wing = payload.get("wing")
    room = payload.get("room")
    has_long_term_memory = bool(memory.manager.long_term.list_wings())
    topic = query if query and has_long_term_memory else None
    messages = memory.build_context(
        session_id=str(payload["session_id"]),
        user_message=query or "Recall relevant context",
        topic=topic,
        wing=wing,
        room=room,
    )
    return str(messages[0].get("content", "")) if messages else ""


def dispatch(memory: AgentMemory, action: str, payload: dict[str, Any]) -> Any:
    if action == "ping":
        return {"version": "0.1.0", "rootDir": str(memory.root_dir)}
    if action == "context":
        return {"context": build_memory_context(memory, payload)}
    if action == "record_user":
        memory.on_user_message(str(payload["session_id"]), str(payload["content"]))
        return {"recorded": True}
    if action == "record_assistant":
        memory.on_assistant_message(str(payload["session_id"]), str(payload["content"]))
        return {"recorded": True}
    if action == "search":
        result = memory.search(
            query=str(payload["query"]),
            wing=payload.get("wing"),
            room=payload.get("room"),
            limit=int(payload.get("limit", 5)),
        )
        return {"matches": format_matches(result)}
    if action == "remember":
        hall = HallType(str(payload.get("hall", HallType.GENERAL.value)))
        record = memory.remember(
            wing=str(payload["wing"]),
            room=str(payload["room"]),
            content=str(payload["content"]),
            source_file=str(payload.get("source_file", "equaxis")),
            hall=hall,
            metadata=payload.get("metadata"),
        )
        return {"record": record}
    if action == "recall":
        return {
            "content": memory.recall(
                wing=payload.get("wing"),
                room=payload.get("room"),
                limit=int(payload.get("limit", 5)),
            )
        }
    if action == "add_fact":
        triple = memory.add_fact(
            subject=str(payload["subject"]),
            predicate=str(payload["predicate"]),
            object_name=str(payload["object"]),
            metadata=payload.get("metadata"),
        )
        return {"triple": triple}
    if action == "query_entity":
        return {"facts": memory.query_entity(str(payload["name"]))}
    if action == "delete_memory":
        drawer_id = str(payload["drawer_id"]).strip()
        if not drawer_id:
            raise ValueError("drawer_id is required")
        memory.manager.long_term.delete_drawer(drawer_id)
        return {"deleted": True, "drawer_id": drawer_id}
    if action == "status":
        return memory.status()
    if action == "close":
        memory.close()
        return {"closed": True}
    raise ValueError(f"Unknown memory action: {action}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Equaxis Agent Memory JSONL bridge")
    parser.add_argument("--root", required=True, help="Memory data root")
    args = parser.parse_args()
    memory = AgentMemory(root_dir=Path(args.root))

    for raw_line in sys.stdin:
        request_id: str | None = None
        try:
            request = json.loads(raw_line)
            request_id = str(request.get("id"))
            action = str(request["action"])
            payload = clean_surrogates(request.get("payload") or {})
            result = dispatch(memory, action, payload)
            emit(request_id, result=result)
            if action == "close":
                return 0
        except Exception as error:  # The Node side receives structured failures.
            emit(request_id, error=error)

    memory.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
