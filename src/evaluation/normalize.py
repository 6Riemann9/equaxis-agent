"""Input normalization boundary.

Harbor-specific parsing currently lives in the compatibility core while the
public API is stabilized. Keeping this boundary explicit lets future runners
emit EvaluationRecord objects without importing Harbor internals.
"""

from .core import load_harbor_records, load_taxonomy

__all__ = ["load_harbor_records", "load_taxonomy"]
