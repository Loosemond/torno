"""Spread the parts of a print layout that would be drawn on top of each other."""

from typing import Any

GAP = 10.0  # mm between neighbours


def spread(named: dict[str, Any]) -> tuple[dict[str, Any], dict[str, list[float]]]:
    """Set overlapping parts side by side along +X.

    A model usually poses each printable for the bed at the origin, so a print
    layout drawn as given is a pile. If the XY bounding boxes of any two parts
    overlap, the parts are moved to sit in a row along +X, in insertion order
    and ``GAP`` apart: the first stays, each keeps its own Y and Z, none is
    turned. Parts that do not overlap are returned as they came.

    Returns the parts, moved or not, and the translation applied to each part
    that was moved, by name.
    """
    if len(named) < 2 or not all(hasattr(s, "bounding_box") for s in named.values()):
        return named, {}
    boxes = {name: shape.bounding_box() for name, shape in named.items()}
    if not _any_overlap(list(boxes.values())):
        return named, {}

    # build123d comes from the user's workspace, so it is imported only here.
    from build123d import Location

    spread_parts = {}
    moves = {}
    edge = None  # where the next part's low X goes
    for name, shape in named.items():
        box = boxes[name]
        dx = 0.0 if edge is None else edge - box.min.X
        edge = box.max.X + dx + GAP
        if abs(dx) < 1e-9:
            spread_parts[name] = shape
        else:
            spread_parts[name] = shape.moved(Location((dx, 0, 0)))
            moves[name] = [dx, 0.0, 0.0]
    return spread_parts, moves


def _any_overlap(boxes: list[Any]) -> bool:
    return any(_overlap(a, b) for i, a in enumerate(boxes) for b in boxes[i + 1 :])


def _overlap(a: Any, b: Any) -> bool:
    """Whether two boxes share area in XY. Touching along an edge is not overlapping."""
    tolerance = 1e-6
    return (
        a.min.X < b.max.X - tolerance
        and b.min.X < a.max.X - tolerance
        and a.min.Y < b.max.Y - tolerance
        and b.min.Y < a.max.Y - tolerance
    )
