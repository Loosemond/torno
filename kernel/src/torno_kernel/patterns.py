"""Holes or bosses that are one feature repeated: on a line, in a grid, round a circle.

Of the holes and bosses ``features`` found, those alike in every way (diameter, shape, end, depth, direction)
whose axes lie at equal steps. Only the axes are looked at, which are exact (a radius' centre is the
B-rep's), so a pattern is as exact as its diameter. A set that is not wholly one pattern is told as none: the
holes are still told one by one.
"""

import math
from typing import Any

Vec = tuple[float, float, float]

# Two positions are the same, and two steps equal, when they are within this of each other, mm.
SAME = 1e-5
# At most so many members are named for one pattern.
MAX_MEMBERS = 24


def patterns(holes: list[dict[str, Any]], bosses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The patterns among ``holes`` and ``bosses``, as ``features`` told them."""
    found: list[dict[str, Any]] = []
    for of, items, where in (("hole", holes, "entry"), ("boss", bosses, "base")):
        groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
        for item in items:
            groups.setdefault(_signature(of, item), []).append(item)
        for members in groups.values():
            if len(members) < 2:
                continue
            axis = _canonical(tuple(members[0]["axis"]))
            points = [tuple(m[where]) for m in members]
            arranged = _arrangement(points, axis)
            if arranged is None:
                continue
            first = members[0]
            told: dict[str, Any] = {"of": of, "count": len(members), "diameter": first["diameter"], "axis": list(axis)}
            if of == "hole":
                told.update(end=first["end"], depth=first["depth"], shape=first["shape"])
                for key in ("bottom", "counterbore", "countersink", "rounded"):
                    if key in first:
                        told[key] = first[key]
            else:
                told["height"] = first["height"]
            told.update(arranged)
            told["entries" if of == "hole" else "bases"] = [list(p) for p in points[:MAX_MEMBERS]]
            told["faces"] = sorted({ref for m in members for ref in m["faces"]})[:MAX_MEMBERS]
            # Alike but for being exact: a pattern is only as exact as the numbers its members have in common.
            told["exact"] = all(m["exact"] for m in members)
            found.append(told)
    found.sort(key=lambda p: (p["of"], -p["count"], p["diameter"]))
    return found


def _canonical(axis: Vec) -> Vec:
    """An axis turned to point the way its first nonzero component does, so that opposite ones are alike."""
    for c in axis:
        if abs(c) > 1e-9:
            return axis if c > 0 else (-axis[0] + 0.0, -axis[1] + 0.0, -axis[2] + 0.0)
    return axis


def _signature(of: str, item: dict[str, Any]) -> tuple[Any, ...]:
    axis = tuple(round(c, 5) + 0.0 for c in _canonical(tuple(item["axis"])))
    if of == "boss":
        return (of, round(item["diameter"], 5), round(item["height"], 4), axis, tuple(s["type"] for s in item["steps"]))
    return (
        of,
        round(item["diameter"], 5),
        item["shape"],
        item["end"],
        round(item["depth"], 4),
        item.get("bottom"),
        tuple(round(item.get("counterbore", {}).get(k, 0.0), 5) for k in ("diameter", "depth")),
        tuple(round(item.get("countersink", {}).get(k, 0.0), 4) for k in ("diameter", "angle")),
        axis,
    )


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(a: Vec) -> Vec:
    n = math.sqrt(_dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n)


def _clean(v: Vec) -> list[float]:
    return [0.0 if abs(c) < 1e-9 else float(c) + 0.0 for c in v]


def _arrangement(points: list[Vec], axis: Vec) -> dict[str, Any] | None:
    """How points (on the axes, so across ``axis`` only) are arranged: a line, a grid or a circle, or None."""
    # Positions across the axis: the same axes are the same wherever along them the points were taken.
    least = min(range(3), key=lambda i: abs(axis[i]))
    helper = tuple(1.0 if i == least else 0.0 for i in range(3))
    e1 = _unit(_cross(axis, helper))  # type: ignore[arg-type]
    e2 = _cross(axis, e1)
    origin = points[0]
    flat = [(_dot(_sub(p, origin), e1), _dot(_sub(p, origin), e2)) for p in points]
    if any(math.dist(flat[i], flat[j]) < SAME for i in range(len(flat)) for j in range(i + 1, len(flat))):
        return None  # two alike on one axis: one in the other, not a pattern
    for one in (_line, _grid, _circle):
        told = one(flat, e1, e2, origin)
        if told is not None:
            return told
    return None


def _to3(plane: tuple[float, float], e1: Vec, e2: Vec, origin: Vec) -> Vec:
    return (
        origin[0] + plane[0] * e1[0] + plane[1] * e2[0],
        origin[1] + plane[0] * e1[1] + plane[1] * e2[1],
        origin[2] + plane[0] * e1[2] + plane[1] * e2[2],
    )


def _line(flat: list[tuple[float, float]], e1: Vec, e2: Vec, origin: Vec) -> dict[str, Any] | None:
    far = max(flat, key=lambda p: math.hypot(*p))
    length = math.hypot(*far)
    d = (far[0] / length, far[1] / length)
    along = sorted((p[0] * d[0] + p[1] * d[1], abs(-p[0] * d[1] + p[1] * d[0])) for p in flat)
    if any(off > SAME for _, off in along):
        return None
    ts = [t for t, _ in along]
    steps = [b - a for a, b in zip(ts, ts[1:])]
    if max(steps) - min(steps) > SAME:
        return None
    direction = _to3(d, e1, e2, (0.0, 0.0, 0.0))
    return {"arrangement": "line", "step": steps[0], "length": ts[-1] - ts[0], "direction": _clean(direction)}


def _spaced(values: list[float]) -> list[float] | None:
    """The distinct values (within SAME) in order, or None when their steps are not equal."""
    ordered = sorted(values)
    distinct = [ordered[0]]
    for v in ordered[1:]:
        if v - distinct[-1] > SAME:
            distinct.append(v)
    if len(distinct) < 2:
        return distinct
    steps = [b - a for a, b in zip(distinct, distinct[1:])]
    return distinct if max(steps) - min(steps) <= SAME else None


def _grid(flat: list[tuple[float, float]], e1: Vec, e2: Vec, origin: Vec) -> dict[str, Any] | None:
    if len(flat) < 4:
        return None
    # The rows run along the way to the nearest of the others from the first, which is a side of a cell.
    near = min(flat[1:], key=lambda p: math.hypot(*p))
    side = math.hypot(*near)
    a_axis = (near[0] / side, near[1] / side)
    b_axis = (-a_axis[1], a_axis[0])
    a = [p[0] * a_axis[0] + p[1] * a_axis[1] for p in flat]
    b = [p[0] * b_axis[0] + p[1] * b_axis[1] for p in flat]
    ua, ub = _spaced(a), _spaced(b)
    if ua is None or ub is None or len(ua) < 2 or len(ub) < 2 or len(ua) * len(ub) != len(flat):
        return None
    cells = {(round(x / SAME / 10), round(y / SAME / 10)) for x, y in zip(a, b)}
    if len(cells) != len(flat):
        return None
    sa, sb = ua[1] - ua[0], ub[1] - ub[0]
    if sa < sb - SAME:
        # The wider step first, whichever way the rows happen to run.
        ua, ub, sa, sb, a_axis, b_axis = ub, ua, sb, sa, b_axis, a_axis
    return {
        "arrangement": "grid",
        "counts": [len(ua), len(ub)],
        "steps": [sa, sb],
        "size": [sa * (len(ua) - 1), sb * (len(ub) - 1)],
        "directions": [_clean(_to3(a_axis, e1, e2, (0.0, 0.0, 0.0))), _clean(_to3(b_axis, e1, e2, (0.0, 0.0, 0.0)))],
    }


def _circle(flat: list[tuple[float, float]], e1: Vec, e2: Vec, origin: Vec) -> dict[str, Any] | None:
    if len(flat) < 3:
        return None
    (x1, y1), (x2, y2), (x3, y3) = flat[0], flat[1], flat[2]
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-12:
        return None
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    radius = math.hypot(x1 - ux, y1 - uy)
    if any(abs(math.hypot(x - ux, y - uy) - radius) > SAME for x, y in flat):
        return None
    angles = sorted(math.atan2(y - uy, x - ux) % (2 * math.pi) for x, y in flat)
    steps = [b - a for a, b in zip(angles, angles[1:])]
    wrap = 2 * math.pi - (angles[-1] - angles[0])
    tol = SAME / radius
    # The ring may start anywhere round: leave out the longest gap and the rest must be even.
    gaps = steps + [wrap]
    longest = max(range(len(gaps)), key=lambda i: gaps[i])
    even = gaps[:longest] + gaps[longest + 1 :]
    if even and max(even) - min(even) > tol:
        return None
    step = (sum(even) / len(even)) if even else gaps[0]
    full = abs(gaps[longest] - step) <= tol
    if not full and len(flat) < 4:
        return None  # three points are always on a circle, and two equal gaps of three are any isosceles triangle
    return {
        "arrangement": "circle",
        "radius": radius,
        "centre": _clean(_to3((ux, uy), e1, e2, origin)),
        "step": math.degrees(step),
        "sweep": 360.0 if full else math.degrees(step * (len(flat) - 1)),
        "full": full,
    }
