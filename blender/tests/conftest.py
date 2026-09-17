"""Pytest configuration for the Tonight generator library.

These tests run **without Blender**. That is the point: the geometry logic is
where the bugs are, so it lives in a ``bpy``-free library that ordinary CI can
exercise on every push (ADR-0004).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
