from __future__ import annotations

import sys
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MEMORY_ROOT = PROJECT_ROOT / "vendor" / "agent-memory"
sys.path.insert(0, str(MEMORY_ROOT))


if __name__ == "__main__":
    raise SystemExit(pytest.main([
        str(MEMORY_ROOT / "tests"),
        str(PROJECT_ROOT / "bridge" / "test_memory_bridge.py"),
        "-q",
    ]))
