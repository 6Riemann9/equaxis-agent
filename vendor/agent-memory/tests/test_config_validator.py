"""Tests for configuration validation and migration."""

import json
import tempfile
from pathlib import Path

import pytest

from memory import MemoryConfig, build_default_config
from memory.config_validator import (
    CONFIG_VERSION,
    check_config_compatibility,
    create_default_config_file,
    load_config_with_version,
    save_config_with_version,
    validate_config,
)
from memory.exceptions import ConfigurationError


class TestConfigValidation:
    def test_validate_valid_config(self):
        config = build_default_config(Path("/tmp/test"))
        warnings = validate_config(config)
        # Root dir doesn't exist, so we expect one warning
        assert len(warnings) == 1
        assert "does not exist" in warnings[0]

    def test_validate_invalid_max_history(self):
        config = build_default_config(Path("/tmp/test"))
        config.max_history_entries = 0
        warnings = validate_config(config)
        assert any("max_history_entries" in w for w in warnings)

    def test_validate_invalid_consolidation_ratio(self):
        config = build_default_config(Path("/tmp/test"))
        config.consolidation.consolidation_ratio = 1.5
        warnings = validate_config(config)
        assert any("consolidation_ratio" in w for w in warnings)

    def test_validate_empty_collection_name(self):
        config = build_default_config(Path("/tmp/test"))
        config.long_term.collection_name = ""
        warnings = validate_config(config)
        assert any("collection_name" in w for w in warnings)


class TestConfigVersioning:
    def test_save_and_load_with_version(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root_dir = Path(tmp.name) / "test-config"
        root_dir.mkdir(parents=True, exist_ok=True)

        config = build_default_config(root_dir)
        config_path = root_dir / "memory.config.json"

        save_config_with_version(config, config_path)

        assert config_path.exists()

        config_data, version = load_config_with_version(config_path)
        assert version == CONFIG_VERSION
        assert "version" in config_data
        assert "saved_at" in config_data

        tmp.cleanup()

    def test_load_missing_config(self):
        with pytest.raises(ConfigurationError, match="not found"):
            load_config_with_version(Path("/nonexistent/config.json"))

    def test_load_invalid_json(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        config_path = Path(tmp.name) / "invalid.json"
        config_path.write_text("{ invalid json }", encoding="utf-8")

        with pytest.raises(ConfigurationError, match="Invalid JSON"):
            load_config_with_version(config_path)

        tmp.cleanup()

    def test_unsupported_version(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        config_path = Path(tmp.name) / "config.json"
        config_path.write_text(
            json.dumps({"version": "99.0.0", "root_dir": "/tmp"}),
            encoding="utf-8"
        )

        with pytest.raises(ConfigurationError, match="Unsupported configuration version"):
            load_config_with_version(config_path)

        tmp.cleanup()


class TestConfigCreation:
    def test_create_default_config_file(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root_dir = Path(tmp.name) / "test-default"
        root_dir.mkdir(parents=True, exist_ok=True)

        config_path = create_default_config_file(root_dir)

        assert config_path.exists()
        assert config_path.name == "memory.config.json"

        config_data = json.loads(config_path.read_text(encoding="utf-8"))
        assert config_data["version"] == CONFIG_VERSION
        assert "saved_at" in config_data

        tmp.cleanup()


class TestConfigCompatibility:
    def test_check_compatible_config(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root_dir = Path(tmp.name) / "test-compat"
        root_dir.mkdir(parents=True, exist_ok=True)

        config_path = create_default_config_file(root_dir)
        status = check_config_compatibility(config_path)

        assert status["compatible"] is True
        assert status["version"] == CONFIG_VERSION
        assert status["needs_migration"] is False

        tmp.cleanup()

    def test_check_missing_config(self):
        status = check_config_compatibility(Path("/nonexistent/config.json"))

        assert status["compatible"] is False
        assert status["version"] == "unknown"
        assert len(status["warnings"]) > 0

    def test_check_invalid_config(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        config_path = Path(tmp.name) / "invalid.json"
        config_path.write_text("{ invalid }", encoding="utf-8")

        status = check_config_compatibility(config_path)

        assert status["compatible"] is False
        assert len(status["warnings"]) > 0

        tmp.cleanup()


class TestConfigValidationIntegration:
    def test_save_invalid_config_raises_error(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root_dir = Path(tmp.name) / "test-invalid"
        root_dir.mkdir(parents=True, exist_ok=True)

        config = build_default_config(root_dir)
        config.max_history_entries = -1  # Invalid

        config_path = root_dir / "config.json"

        with pytest.raises(ConfigurationError, match="validation failed"):
            save_config_with_version(config, config_path)

        tmp.cleanup()
