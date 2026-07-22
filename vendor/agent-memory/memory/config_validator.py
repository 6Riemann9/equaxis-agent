"""Configuration validation and migration utilities."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from memory.config import MemoryConfig
from memory.exceptions import ConfigurationError


# Configuration version history
CONFIG_VERSION = "1.0.0"
SUPPORTED_VERSIONS = ["1.0.0"]


def validate_config(config: MemoryConfig) -> list[str]:
    """
    Validate configuration and return list of warnings.

    Returns:
        List of warning messages (empty if valid)
    """
    warnings = []

    # Validate paths
    if not config.root_dir.exists():
        warnings.append(f"Root directory does not exist: {config.root_dir}")

    # Validate numeric values
    if config.max_history_entries < 1:
        warnings.append("max_history_entries must be >= 1")

    if config.recent_history_limit < 1:
        warnings.append("recent_history_limit must be >= 1")

    if config.recent_history_char_limit < 100:
        warnings.append("recent_history_char_limit should be >= 100")

    # Validate dream config
    if config.dream.interval_hours < 1:
        warnings.append("dream.interval_hours must be >= 1")

    if config.dream.max_batch_size < 1:
        warnings.append("dream.max_batch_size must be >= 1")

    if config.dream.max_iterations < 1:
        warnings.append("dream.max_iterations must be >= 1")

    # Validate consolidation config
    if config.consolidation.context_window_tokens < 1000:
        warnings.append("consolidation.context_window_tokens should be >= 1000")

    if config.consolidation.max_completion_tokens < 100:
        warnings.append("consolidation.max_completion_tokens should be >= 100")

    if not 0.0 < config.consolidation.consolidation_ratio < 1.0:
        warnings.append("consolidation.consolidation_ratio must be between 0 and 1")

    # Validate string fields
    if not config.long_term.collection_name:
        warnings.append("long_term.collection_name cannot be empty")

    if not config.long_term.embedding_model:
        warnings.append("long_term.embedding_model cannot be empty")

    if not config.knowledge_graph.sqlite_filename:
        warnings.append("knowledge_graph.sqlite_filename cannot be empty")

    return warnings


def load_config_with_version(config_path: Path) -> tuple[dict[str, Any], str]:
    """
    Load configuration file and extract version.

    Returns:
        Tuple of (config_dict, version)
    """
    if not config_path.exists():
        raise ConfigurationError(f"Configuration file not found: {config_path}")

    try:
        config_data = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigurationError(f"Invalid JSON in configuration file: {e}") from e

    version = config_data.get("version", "1.0.0")

    if version not in SUPPORTED_VERSIONS:
        raise ConfigurationError(
            f"Unsupported configuration version: {version}. "
            f"Supported versions: {', '.join(SUPPORTED_VERSIONS)}"
        )

    return config_data, version


def migrate_config(config_data: dict[str, Any], from_version: str, to_version: str) -> dict[str, Any]:
    """
    Migrate configuration from one version to another.

    Args:
        config_data: Configuration dictionary
        from_version: Source version
        to_version: Target version

    Returns:
        Migrated configuration dictionary
    """
    if from_version == to_version:
        return config_data

    # Future migration logic would go here
    # For now, we only have version 1.0.0

    # Example migration pattern:
    # if from_version == "1.0.0" and to_version == "1.1.0":
    #     config_data = _migrate_1_0_to_1_1(config_data)

    return config_data


def save_config_with_version(config: MemoryConfig, config_path: Path) -> None:
    """
    Save configuration with version information.

    Args:
        config: Configuration object
        config_path: Path to save configuration
    """
    config_dict = asdict(config)
    config_dict["version"] = CONFIG_VERSION
    config_dict["root_dir"] = str(config.root_dir)
    config_dict["saved_at"] = datetime.now(timezone.utc).isoformat()

    # Validate before saving
    warnings = validate_config(config)
    if warnings:
        raise ConfigurationError(f"Configuration validation failed: {'; '.join(warnings)}")

    config_path.write_text(
        json.dumps(config_dict, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def create_default_config_file(root_dir: Path) -> Path:
    """
    Create a default configuration file with version.

    Args:
        root_dir: Root directory for the memory system

    Returns:
        Path to created configuration file
    """
    from memory.config import build_default_config

    config = build_default_config(root_dir)
    config_path = root_dir / "memory.config.json"

    save_config_with_version(config, config_path)

    return config_path


def check_config_compatibility(config_path: Path) -> dict[str, Any]:
    """
    Check configuration file compatibility and return status.

    Returns:
        Dictionary with compatibility information:
        - compatible: bool
        - version: str
        - warnings: list[str]
        - needs_migration: bool
    """
    try:
        config_data, version = load_config_with_version(config_path)

        from memory.loader import ConfigLoader
        loader = ConfigLoader(config_path.parent)
        config = loader.load()

        warnings = validate_config(config)

        return {
            "compatible": True,
            "version": version,
            "current_version": CONFIG_VERSION,
            "warnings": warnings,
            "needs_migration": version != CONFIG_VERSION,
        }
    except ConfigurationError as e:
        return {
            "compatible": False,
            "version": "unknown",
            "current_version": CONFIG_VERSION,
            "warnings": [str(e)],
            "needs_migration": False,
        }
