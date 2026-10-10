"""One line that says what a face, an edge or a part is, for a person and for the agent.

Nothing here touches geometry: a descriptor is written from facts already
measured, the ones ``queries.describe`` replies with.
"""

import math
from collections.abc import Sequence
from typing import Any

_AXES = "XYZ"
# A direction this close to an axis is named after it.
_ON_AXIS = math.cos(math.radians(0.5))
_ZERO = 1e-9
# A length, an area or a coordinate smaller than this is what modelling leaves
# where it means nothing: a face "at z = -0.0000001" is at 0.
_NOISE = 1e-6
# Nor does a coordinate or a size under this part of its part's extent mean
# anything: a plane "at z = -0.000004772" on a part 200 mm long is at 0.
OF_THE_PART = 1e-6


def descriptor(kind: str, facts: dict[str, Any]) -> str:
    """Describe a ``face``, an ``edge`` or a ``part`` in one line.

    ``facts`` are the fields of a ``describe`` reply for that kind; a cylinder's
    line also wants its ``axis`` and a circle's its ``radius``, and a plane's
    the ``span`` of its part, mm, under a millionth of which a coordinate is 0.
    Lengths are in millimetres, at most four significant digits::

        plane, normal +Z, z = 20, 1180 mm²
        cylinder, radius 4, axis Z, 502.7 mm²
        bspline, ≈ 913.2 mm²
        circle, radius 4, 25.13 mm
        part, 40 × 30 × 5 mm, 6000 mm³, 6 faces
        part, ≈ 130 × 208 × 120 mm, ≈ 84470 mm³, 92 faces
    """
    if kind == "face":
        # An area that is not exact is said as about that much.
        about = "≈ " if facts.get("areaExact") is False else ""
        return ", ".join([*_surface(facts), f"{about}{number(facts['area'])} mm²"])
    if kind == "edge":
        return ", ".join([*_curve(facts), f"{number(facts['length'])} mm"])
    if kind == "part":
        return _part(facts)
    raise ValueError(f"nothing is described as a {kind!r}; the kinds are face, edge and part")


def number(value: float, least: float = 0.0) -> str:
    """A number with at most four significant digits and no trailing zeros.

    Millimetres are meant: a magnitude under a millionth is written ``0``,
    and so is one under ``least``, which a coordinate or a size is given: a
    millionth of the extent of its part.
    """
    value = float(value)
    if not math.isfinite(value):
        return str(value)
    if abs(value) < max(_NOISE, least):
        return "0"
    decimals = 3 - math.floor(math.log10(abs(value)))
    rounded = round(value, decimals)
    if decimals <= 0:
        return str(int(rounded))
    return f"{rounded:.{decimals}f}".rstrip("0").rstrip(".")


def _surface(facts: dict[str, Any]) -> list[str]:
    type = facts["type"]
    normal, radius, axis = facts.get("normal"), facts.get("radius"), facts.get("axis")
    if type == "plane" and normal is not None:
        index = _axis_index(normal)
        if index is None:
            return [type, f"normal {_vector(normal)}"]
        sign = "+" if normal[index] > 0 else "-"
        least = OF_THE_PART * (facts.get("span") or 0.0)
        at = f"{_AXES[index].lower()} = {number(facts['center'][index], least)}"
        return [type, f"normal {sign}{_AXES[index]}", at]
    if type == "cylinder" and radius is not None and axis is not None:
        index = _axis_index(axis)
        along = _vector(axis) if index is None else _AXES[index]
        return [type, f"radius {number(radius)}", f"axis {along}"]
    return [type]


def _curve(facts: dict[str, Any]) -> list[str]:
    type, radius = facts["type"], facts.get("radius")
    if type == "circle" and radius is not None:
        return [type, f"radius {number(radius)}"]
    return [type]


def _part(facts: dict[str, Any]) -> str:
    low, high = facts["bbox"]["min"], facts["bbox"]["max"]
    least = OF_THE_PART * math.dist(low, high)
    size = " × ".join(number(b - a, least) for a, b in zip(low, high, strict=True))
    faces = facts["faceCount"]
    # A size and a volume that are not exact are said as about that much.
    boxed = "≈ " if facts.get("bboxExact") is False else ""
    about = "≈ " if facts.get("volumeExact") is False else ""
    return (
        f"part, {boxed}{size} mm, {about}{number(facts['volume'])} mm³, "
        f"{faces} face{'' if faces == 1 else 's'}"
    )


def _axis_index(direction: Sequence[float]) -> int | None:
    """Which of X, Y, Z the direction runs along, either way, or None if it is tilted."""
    length = math.sqrt(sum(c * c for c in direction))
    if length < _ZERO:
        return None
    for index, component in enumerate(direction):
        if abs(component) / length >= _ON_AXIS:
            return index
    return None


def _vector(direction: Sequence[float]) -> str:
    """A direction to two decimals: ``(0.71, 0, 0.71)``."""
    parts = []
    for component in direction:
        text = f"{component:.2f}".rstrip("0").rstrip(".")
        parts.append("0" if text in ("-0", "") else text)
    return f"({', '.join(parts)})"
