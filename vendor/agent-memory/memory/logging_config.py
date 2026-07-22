"""Logging configuration for the memory system."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any


def setup_logger(
    name: str = "memory",
    level: int = logging.INFO,
    log_file: Path | None = None,
    format_string: str | None = None,
) -> logging.Logger:
    """
    Configure and return a logger for the memory system.

    Args:
        name: Logger name
        level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_file: Optional file path for logging output
        format_string: Optional custom format string

    Returns:
        Configured logger instance
    """
    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Remove existing handlers to avoid duplicates
    logger.handlers.clear()

    # Default format
    if format_string is None:
        format_string = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

    formatter = logging.Formatter(format_string)

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # File handler (optional)
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger


def get_logger(name: str = "memory") -> logging.Logger:
    """Get or create a logger instance."""
    return logging.getLogger(name)
