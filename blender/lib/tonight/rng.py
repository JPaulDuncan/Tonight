"""Seeded randomness.

Generators must be deterministic (ADR-0004): re-running one reproduces the same
mesh, which is what lets CI assert mesh hashes and catch an unintended geometry
change.

Using the module-level :mod:`random` functions would tie a generator's output to
whatever ran before it in the same process, so ``build_all.py`` would produce
different results than running one generator alone. Every generator takes its
own stream from :func:`seeded`.
"""

from __future__ import annotations

import hashlib
import random


def stable_hash(name: str) -> int:
    """A process-independent hash of ``name``.

    Python's built-in :func:`hash` is randomised per process by default, which
    would make "deterministic" generators produce different meshes on every run.
    """
    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=False)


def seeded(name: str, salt: int = 0) -> random.Random:
    """Return an independent RNG stream for ``name``.

    Args:
        name: A stable identifier, conventionally the asset name.
        salt: An extra discriminator, for generating variants of one asset.
    """
    return random.Random(stable_hash(name) ^ (salt * 0x9E3779B9))
