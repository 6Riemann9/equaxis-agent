from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timezone
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


def build_export(memory: AgentMemory, payload: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(payload.get("limit", 2000)), 5000))
    visualization = build_visualization(memory, {"limit": limit})
    history = memory.manager.short_term.read_unprocessed_history(0)
    return {
        "generated_at": visualization["generated_at"],
        "status": visualization["status"],
        "drawers": visualization["drawers"],
        "facts": visualization["facts"],
        "history": [
            {
                "cursor": entry.cursor,
                "timestamp": entry.timestamp.isoformat(),
                "session_id": entry.session_id,
                "content": entry.content,
            }
            for entry in history
        ],
    }


def run_memory_repair(memory: AgentMemory, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Repair the short-term cursor and report store integrity.

    Fixes: a corrupt/missing record cursor (rebuilt from history). Reports:
    history line parse failures and lone-surrogate damage, drawer count, and
    embedding readiness (a real probe query that loads the embedding model).

    With ``clean=True``, history lines containing U+FFFD (mojibake from old
    encoding damage) are dropped entirely — opt-in, since it deletes content.
    """
    payload = payload or {}
    short = memory.manager.short_term
    cursor_path = short.config.cursor_path
    stored_cursor = short._read_int(cursor_path)
    max_cursor = max((entry.cursor for entry in short._iter_history_entries()), default=0)
    repaired = stored_cursor <= 0 and max_cursor > 0
    if repaired:
        short._write_int(cursor_path, max_cursor)

    damaged_lines = 0
    unparseable_lines = 0
    total_lines = 0
    cleaned = 0
    history_path = short.config.history_path
    if cursor_path.parent.exists() and history_path.exists():
        lines = history_path.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in lines:
            total_lines += 1
            if "\ufffd" in line:
                damaged_lines += 1
            try:
                json.loads(line)
            except (json.JSONDecodeError, ValueError):
                unparseable_lines += 1
        if payload.get("clean") and damaged_lines:
            kept = [line for line in lines if "\ufffd" not in line]
            cleaned = total_lines - len(kept)
            history_path.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")

    drawers = 0
    try:
        drawers = len(memory.manager.long_term.drawers.get(include=["metadatas"])["ids"])
    except Exception as error:  # pragma: no cover - depends on chroma state
        drawers = -1

    embedding = {"ok": False, "model": memory.manager.long_term.config.long_term.embedding_model}
    try:
        memory.manager.long_term.drawers.query(query_texts=["readiness probe"], n_results=1)
        embedding["ok"] = True
    except Exception as error:
        embedding["error"] = str(error)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cursor": {"stored": stored_cursor, "rebuilt": max_cursor, "repaired": repaired},
        "history": {"lines": total_lines, "damaged": damaged_lines, "unparseable": unparseable_lines},
        "drawers": drawers,
        "embedding": embedding,
        "cleaned": cleaned,
    }


def build_visualization(memory: AgentMemory, payload: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(payload.get("limit", 500)), 500))
    drawer_payload = memory.manager.long_term.drawers.get(
        limit=limit,
        include=["documents", "metadatas"],
    )
    drawers = []
    ids = drawer_payload.get("ids") or []
    documents = drawer_payload.get("documents") or []
    metadatas = drawer_payload.get("metadatas") or []
    for index, drawer_id in enumerate(ids):
        metadata = metadatas[index] if index < len(metadatas) else {}
        drawers.append({
            "id": drawer_id,
            "content": documents[index] if index < len(documents) else "",
            "wing": metadata.get("wing", "unknown"),
            "room": metadata.get("room", "general"),
            "hall": metadata.get("hall", "hall_general"),
            "source_file": metadata.get("source_file", ""),
            "filed_at": metadata.get("filed_at"),
            "metadata": memory.manager.long_term._extra_metadata(metadata),
        })

    with memory.manager.knowledge_graph.connection() as conn:
        rows = conn.execute(
            "SELECT * FROM triples ORDER BY extracted_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    facts = []
    for row in rows:
        fact = dict(row)
        fact["metadata"] = json.loads(fact.get("metadata") or "{}")
        facts.append(fact)

    status = memory.status()
    rooms = {
        wing: memory.manager.long_term.list_rooms(wing)
        for wing in status.get("wings", {})
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "rooms": rooms,
        "drawers": drawers,
        "facts": facts,
        "truncated": {
            "drawers": sum(status.get("wings", {}).values()) > len(drawers),
            "facts": status.get("knowledge_graph", {}).get("triples", 0) > len(facts),
        },
    }


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
    if action == "embed":
        texts = [str(t) for t in payload.get("texts", [])]
        if not texts:
            raise ValueError("texts is required")
        return {"vectors": memory.embed(texts)}
    if action == "search":
        result = memory.search(
            query=str(payload["query"]),
            wing=payload.get("wing"),
            room=payload.get("room"),
            limit=int(payload.get("limit", 5)),
        )
        return {"matches": format_matches(result)}
    if action == "associative_search":
        result = memory.associative_search(
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
    if action == "update_memory":
        drawer_id = str(payload["drawer_id"]).strip()
        if not drawer_id:
            raise ValueError("drawer_id is required")
        hall_raw = payload.get("hall")
        hall = HallType(str(hall_raw)) if hall_raw is not None else None
        updated = memory.manager.long_term.update_drawer(
            drawer_id=drawer_id,
            content=payload.get("content"),
            wing=payload.get("wing"),
            room=payload.get("room"),
            hall=hall,
            source_file=payload.get("source_file"),
            metadata=payload.get("metadata"),
            added_by=payload.get("added_by"),
        )
        if updated is None:
            raise ValueError(f"Unknown drawer: {drawer_id}")
        return {"updated": True, "record": updated}
    if action == "status":
        return memory.status()
    if action == "pending_history":
        limit = max(1, min(int(payload.get("limit", 200)), 500))
        dream_cursor = memory.manager.short_term.get_last_dream_cursor()
        entries = memory.manager.short_term.read_unprocessed_history(dream_cursor, limit=limit)
        return {
            "dream_cursor": dream_cursor,
            "entries": [
                {
                    "cursor": entry.cursor,
                    "content": entry.content,
                    "session_id": entry.session_id,
                    "timestamp": entry.timestamp.isoformat(),
                }
                for entry in entries
            ],
        }
    if action == "set_dream_cursor":
        cursor = int(payload["cursor"])
        if cursor < 0:
            raise ValueError("cursor must be >= 0")
        memory.manager.short_term.set_last_dream_cursor(cursor)
        return {"ok": True, "dream_cursor": cursor}
    if action == "visualize":
        return build_visualization(memory, payload)
    if action == "export":
        return build_export(memory, payload)
    if action == "repair":
        return run_memory_repair(memory, payload)
    if action == "close":
        memory.close()
        return {"closed": True}
    raise ValueError(f"Unknown memory action: {action}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Equaxis Agent Memory JSONL bridge")
    parser.add_argument("--root", required=True, help="Memory data root")
    parser.add_argument("--snapshot", action="store_true", help="Print one visualization snapshot and exit")
    parser.add_argument("--limit", type=int, default=500, help="Snapshot item limit (max 500)")
    args = parser.parse_args()
    memory = AgentMemory(root_dir=Path(args.root))

    if args.snapshot:
        try:
            print(json.dumps(clean_surrogates(build_visualization(memory, {"limit": args.limit})), ensure_ascii=True, default=json_default))
            return 0
        finally:
            memory.close()

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
