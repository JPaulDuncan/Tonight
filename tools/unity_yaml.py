"""Write Unity ``.meta`` and ``.asset`` files from Python.

Unity normally generates these, but Tonight needs them authored outside the
Editor for two reasons:

* CI and contributors without a Unity licence still get a project with real
  content in it, so ``tools/validate_blueprints.py`` validates something rather
  than reporting "0 assets".
* Seed content becomes reviewable in a diff and reproducible from a spec,
  which is the same argument ADR-0004 makes for art.

GUIDs are derived from the repository-relative path, so they are stable across
machines and runs. That matters enormously: a GUID is an asset's identity, and
a regenerated GUID silently breaks every reference to it.

Unity accepts any 32-character lowercase hex GUID, so deriving rather than
randomising costs nothing and buys reproducibility.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

# Unity's fileIDs for the two object kinds this module writes.
MONO_BEHAVIOUR_FILE_ID = 11400000
MONO_SCRIPT_FILE_ID = 11500000

#: Reference `type:` discriminators in Unity YAML.
TYPE_ASSET = 2   # a .asset / imported asset
TYPE_SCRIPT = 3  # a MonoScript


def guid_for(repo_relative_path: str) -> str:
    """Deterministic GUID for a path.

    Uses MD5 of the path purely as a 128-bit spreading function -- there is no
    security property wanted here, only stability and low collision odds.
    """
    return hashlib.md5(repo_relative_path.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------
# Value wrappers
#
# Unity's YAML is not general YAML: object references, colours, layer masks and
# curves each have a fixed shape. These wrappers mark a Python value so the
# serialiser emits the right one.
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Ref:
    """A reference to another asset. ``None`` guid means a null reference."""

    guid: str | None = None
    file_id: int = MONO_BEHAVIOUR_FILE_ID
    ref_type: int = TYPE_ASSET

    def render(self) -> str:
        if not self.guid:
            return "{fileID: 0}"
        return f"{{fileID: {self.file_id}, guid: {self.guid}, type: {self.ref_type}}}"


@dataclass(frozen=True)
class Colour:
    r: float
    g: float
    b: float
    a: float = 1.0

    def render(self) -> str:
        return (
            f"{{r: {_num(self.r)}, g: {_num(self.g)}, "
            f"b: {_num(self.b)}, a: {_num(self.a)}}}"
        )


@dataclass(frozen=True)
class LayerMask:
    bits: int

    def render(self) -> str:
        return f"{{serializedVersion: 2, m_Bits: {self.bits}}}"


@dataclass(frozen=True)
class Enum:
    """An enum field. Unity serialises these as their integer value."""

    value: int

    def render(self) -> str:
        return str(self.value)


@dataclass(frozen=True)
class Nested:
    """A `[Serializable]` struct or class serialised inline."""

    fields: dict


@dataclass(frozen=True)
class Curve:
    """An ``AnimationCurve`` as (time, value) pairs."""

    keys: tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class Gradient:
    """A ``Gradient`` as (time, Colour) stops. Unity supports up to 8."""

    stops: tuple[tuple[float, Colour], ...]


def _num(value: float) -> str:
    """Render a number the way Unity does: no trailing ``.0`` on integers."""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return repr(round(float(value), 6))


def _render_scalar(value) -> str | None:
    """Render a value that fits on one line, or None if it needs a block."""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return _num(value)
    if isinstance(value, str):
        # Unity leaves ordinary strings unquoted; quote only when YAML would
        # otherwise misread the value.
        if value == "" or value[0] in "!&*[]{}#|>%@`\"'" or ": " in value:
            return f'"{value}"'
        return value
    if hasattr(value, "render"):
        return value.render()
    return None


def _render_block(key: str, value, indent: int) -> list[str]:
    """Render one field, which may span several lines."""
    pad = " " * indent
    scalar = _render_scalar(value)
    if scalar is not None:
        return [f"{pad}{key}: {scalar}"]

    if isinstance(value, Nested):
        lines = [f"{pad}{key}:"]
        for sub_key, sub_value in value.fields.items():
            lines.extend(_render_block(sub_key, sub_value, indent + 2))
        return lines

    if isinstance(value, Curve):
        lines = [f"{pad}{key}:", f"{pad}  serializedVersion: 2", f"{pad}  m_Curve:"]
        for time, val in value.keys:
            lines.extend(
                [
                    f"{pad}  - serializedVersion: 3",
                    f"{pad}    time: {_num(time)}",
                    f"{pad}    value: {_num(val)}",
                    f"{pad}    inSlope: 0",
                    f"{pad}    outSlope: 0",
                    f"{pad}    tangentMode: 0",
                    f"{pad}    weightedMode: 0",
                    f"{pad}    inWeight: 0.33333334",
                    f"{pad}    outWeight: 0.33333334",
                ]
            )
        lines.extend(
            [
                f"{pad}  m_PreInfinity: 2",
                f"{pad}  m_PostInfinity: 2",
                f"{pad}  m_RotationOrder: 4",
            ]
        )
        return lines

    if isinstance(value, Gradient):
        if len(value.stops) > 8:
            raise ValueError("Unity gradients support at most 8 colour keys.")
        lines = [f"{pad}{key}:", f"{pad}  serializedVersion: 2"]
        for index in range(8):
            stop = value.stops[min(index, len(value.stops) - 1)]
            lines.append(f"{pad}  key{index}: {stop[1].render()}")
        for index in range(8):
            # Unity stores key times as 0..65535.
            stop = value.stops[min(index, len(value.stops) - 1)]
            lines.append(f"{pad}  ctime{index}: {int(round(stop[0] * 65535))}")
        for index in range(8):
            lines.append(f"{pad}  atime{index}: {index * 65535}")
        lines.extend(
            [
                f"{pad}  m_Mode: 0",
                f"{pad}  m_ColorSpace: -1",
                f"{pad}  m_NumColorKeys: {len(value.stops)}",
                f"{pad}  m_NumAlphaKeys: 2",
            ]
        )
        return lines

    if isinstance(value, (list, tuple)):
        if not value:
            return [f"{pad}{key}: []"]
        lines = [f"{pad}{key}:"]
        for element in value:
            element_scalar = _render_scalar(element)
            if element_scalar is not None:
                lines.append(f"{pad}- {element_scalar}")
            elif isinstance(element, Nested):
                items = list(element.fields.items())
                first_key, first_value = items[0]
                first = _render_block(first_key, first_value, indent + 2)
                # The first line of a list element carries the "- " marker.
                lines.append(f"{pad}- {first[0].strip()}")
                lines.extend(first[1:])
                for sub_key, sub_value in items[1:]:
                    lines.extend(_render_block(sub_key, sub_value, indent + 2))
            else:
                raise TypeError(f"Cannot serialise list element {element!r}")
        return lines

    raise TypeError(f"Cannot serialise {key}={value!r} of type {type(value).__name__}")


def render_scriptable_object(script_guid: str, name: str, fields: dict) -> str:
    """Render a ScriptableObject ``.asset`` file."""
    lines = [
        "%YAML 1.1",
        "%TAG !u! tag:unity3d.com,2011:",
        f"--- !u!114 &{MONO_BEHAVIOUR_FILE_ID}",
        "MonoBehaviour:",
        "  m_ObjectHideFlags: 0",
        "  m_CorrespondingSourceObject: {fileID: 0}",
        "  m_PrefabInstance: {fileID: 0}",
        "  m_PrefabAsset: {fileID: 0}",
        "  m_GameObject: {fileID: 0}",
        "  m_Enabled: 1",
        "  m_EditorHideFlags: 0",
        f"  m_Script: {{fileID: {MONO_SCRIPT_FILE_ID}, "
        f"guid: {script_guid}, type: {TYPE_SCRIPT}}}",
        f"  m_Name: {name}",
        "  m_EditorClassIdentifier: ",
    ]
    for key, value in fields.items():
        lines.extend(_render_block(key, value, 2))
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# .meta files
# --------------------------------------------------------------------------

_META_IMPORTERS = {
    ".cs": "MonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n"
           "  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}",
    ".asmdef": "AssemblyDefinitionImporter:\n  externalObjects: {}",
    ".asset": "NativeFormatImporter:\n  externalObjects: {}\n"
              "  mainObjectFileID: 11400000",
    ".json": "TextScriptImporter:\n  externalObjects: {}",
    ".md": "TextScriptImporter:\n  externalObjects: {}",
}

_META_TAIL = "  userData: \n  assetBundleName: \n  assetBundleVariant: \n"


def render_meta(repo_relative_path: str, is_folder: bool = False) -> str:
    """Render a ``.meta`` file for an asset or folder."""
    guid = guid_for(repo_relative_path)

    if is_folder:
        return (
            f"fileFormatVersion: 2\nguid: {guid}\nfolderAsset: yes\n"
            f"DefaultImporter:\n  externalObjects: {{}}\n{_META_TAIL}"
        )

    suffix = Path(repo_relative_path).suffix
    importer = _META_IMPORTERS.get(suffix, "DefaultImporter:\n  externalObjects: {}")
    return f"fileFormatVersion: 2\nguid: {guid}\n{importer}\n{_META_TAIL}"


def write_meta(path: Path, repo_root: Path, is_folder: bool = False) -> Path:
    """Write the ``.meta`` beside ``path``, returning the meta's path."""
    relative = path.relative_to(repo_root).as_posix()
    meta = path.parent / (path.name + ".meta")
    meta.write_text(render_meta(relative, is_folder), encoding="utf-8")
    return meta
