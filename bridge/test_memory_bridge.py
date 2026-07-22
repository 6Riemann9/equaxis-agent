from __future__ import annotations

import json

import memory_bridge


def test_emit_outputs_ascii_jsonl_for_non_ascii_content(capsys):
    content = "\u4e2d\u6587\ufffd"
    memory_bridge.emit("1", result={"content": content})

    raw = capsys.readouterr().out.strip()
    assert raw.isascii()
    assert raw.startswith(memory_bridge.RESPONSE_PREFIX)
    assert "\\u4e2d" in raw
    assert "\\ufffd" in raw

    payload = json.loads(raw[len(memory_bridge.RESPONSE_PREFIX):])
    assert payload == {
        "id": "1",
        "ok": True,
        "result": {"content": content},
    }
