"""A build123d selector that picks a face or an edge of a part now, for ``describe``.

A face or an edge is named by a ref (``lid/F12``) that the next build may renumber, while the model must pick it in
code, and an agent writes that selector by hand from a descriptor ("plane, normal +Z, z = 20"). Here the kernel
tries a short list of forms on the part as it was built, from the most robust to the least, and gives the first
that picks exactly that shape and no other:

1. its type, or its direction (``filter_by(Axis.Z)``: the planar faces across Z, the lines along it), when that
   alone picks it;
2. the extreme of those along an axis (``sort_by(Axis.Z)[-1]``), when no other is as far along it, or the extreme
   along one axis and then along another among those that tie (``group_by(Axis.X)[0].sort_by(Axis.Y)[-1]``);
3. a value it has: where it is, its radius, its area or length, alone or with an extreme;
4. its place in the sort along an axis (``sort_by(Axis.X)[2]``), told ``by order``: the next edit may break it.

Each form is the text of an expression on ``part``, evaluated here with build123d on the part's own shape and kept
only if the result is that one shape. The worker evaluates expressions it made itself and nothing else: the text is
put together from a fixed list of method names, the names of build123d's own enumerations and numbers it wrote with
``repr``; nothing of a tool's arguments is in it (the ref only says which shape). Evaluation is given a namespace
with ``part``, ``Axis``, ``GeomType``, ``Vector`` and ``abs``, and no builtins.

The selector is of the part as it stands in the layout asked, in that layout's frame. A selector found is checked on
this build only.
"""

import time
from collections.abc import Callable
from typing import Any

# Seconds the search may take of its query's 30: each candidate is a pass over the part's faces or edges.
BUDGET = 10.0
# Two coordinates this close along an axis (mm) are a tie: an extreme or a place in a sort between them is not told.
TIE = 1e-5
# How close a coordinate, a radius, an area or a length must be to the one told (mm, mm², relative for the last two).
CLOSE = 1e-3
_AXES = "XYZ"
# The forms that stand on a value tell it as written to this many decimals: well inside CLOSE.
_DECIMALS = 4

BY_GEOMETRY = "by geometry"
BY_ORDER = "by order"


def selector_for(
    part: Any, target: Any, kind: str, budget: float = BUDGET, clock: Callable[[], float] = time.monotonic
) -> dict[str, Any]:
    """``{"selector": {...}}`` with the ``expression`` (on ``part``), how ``robust`` it is (``by geometry`` or ``by
    order``) and what it was ``checked`` on; or ``{"selector": None, "selectorWhy": ...}`` when no form picks only
    this shape in the time given. ``part`` is the build123d shape the ref is of, ``target`` the TopoDS face or edge,
    ``kind`` ``face`` or ``edge``."""
    try:
        return _Search(part, target, kind, clock() + max(0.0, budget), clock).run()
    except Exception as e:  # a selector that cannot be made is none: describe still answers
        return {"selector": None, "selectorWhy": f"no selector could be made of it ({type(e).__name__})"}


class _Part:
    """Stands for the part in an evaluated expression: its faces and edges are taken once, and every selection
    makes a new list, so the same list serves each candidate."""

    def __init__(self, part: Any) -> None:
        self._part = part
        self._cache: dict[str, Any] = {}

    def faces(self) -> Any:
        if "faces" not in self._cache:
            self._cache["faces"] = self._part.faces()
        return self._cache["faces"]

    def edges(self) -> Any:
        if "edges" not in self._cache:
            self._cache["edges"] = self._part.edges()
        return self._cache["edges"]


class _Search:
    def __init__(self, part: Any, target: Any, kind: str, deadline: float, clock: Callable[[], float]) -> None:
        from build123d import Axis, Edge, Face, GeomType, Vector

        self.kind = kind
        self.target = target
        self.shape = Face(target) if kind == "face" else Edge(target)
        self.deadline = deadline
        self.clock = clock
        self.globals: dict[str, Any] = {
            "__builtins__": {"abs": abs},
            "part": _Part(part),
            "Axis": Axis,
            "GeomType": GeomType,
            "Vector": Vector,
        }
        self.GeomType = GeomType
        self.prefixes: dict[str, list[Any] | None] = {}
        self.cut_short = False

    # The facts of the target that the forms are made of

    def facts(self) -> dict[str, Any]:
        shape = self.shape
        center = shape.center()
        facts: dict[str, Any] = {
            "type": shape.geom_type.name,
            "center": (float(center.X), float(center.Y), float(center.Z)),
            "axis": None,
            "radius": None,
            "size": None,
        }
        facts["axis"] = self._axis_of(shape)
        if facts["type"] in ("CYLINDER", "SPHERE", "CIRCLE"):
            try:
                radius = shape.radius
                facts["radius"] = None if radius is None else float(radius)
            except Exception:
                pass
        try:
            facts["size"] = float(shape.area if self.kind == "face" else shape.length)
        except Exception:
            pass
        return facts

    def _axis_of(self, shape: Any) -> int | None:
        """The axis a planar face is across or a line runs along, if one."""
        try:
            if self.kind == "face":
                if shape.geom_type.name != "PLANE":
                    return None
                direction = shape.normal_at()
            else:
                if shape.geom_type.name != "LINE":
                    return None
                direction = shape.tangent_at(0.5)
            components = (abs(direction.X), abs(direction.Y), abs(direction.Z))
        except Exception:
            return None
        for index, component in enumerate(components):
            if component > 1 - 1e-6:
                return index
        return None

    # The search

    def run(self) -> dict[str, Any]:
        facts = self.facts()
        for tier, steps in self._candidates(facts):
            if self.clock() >= self.deadline:
                self.cut_short = True
                break
            try:
                found = self._try(*steps)
            except Exception:
                found = None  # a form that cannot be evaluated here is no form
            if found is not None:
                return {"selector": {"expression": found, "robust": tier, "checked": "this build only"}}
        why = (
            "the search for one ran out of time"
            if self.cut_short
            else f"no selector picks only this {self.kind}: others are as far along every axis, or have the same size"
        )
        return {"selector": None, "selectorWhy": why}

    def _candidates(self, facts: dict[str, Any]) -> Any:
        """The forms to try, as ``(robust, (prefix, terminal))``, the most robust first. A prefix is the text of a
        selection; its terminal is how one is taken of it: ``only``, ``("end", axis, 0 or -1)`` or ``("order", axis)``."""
        name = "faces" if self.kind == "face" else "edges"
        var = "f" if self.kind == "face" else "e"
        gtype, axis, radius, size, (cx, cy, cz) = facts["type"], facts["axis"], facts["radius"], facts["size"], facts["center"]
        base = f"part.{name}()"
        by_type = f"{base}.filter_by(GeomType.{gtype})"
        by_axis = None if axis is None else f"{base}.filter_by(Axis.{_AXES[axis]})"
        at = f"{by_type}.filter_by(lambda {var}: ({var}.center() - Vector({_n(cx)}, {_n(cy)}, {_n(cz)})).length < {CLOSE:g})"
        by_radius = None if radius is None else f"{by_type}.filter_by(lambda {var}: abs({var}.radius - {_n(radius)}) < {CLOSE:g})"
        quantity = "area" if self.kind == "face" else "length"
        by_size = None
        if size is not None:
            tolerance = max(CLOSE, abs(size) * 1e-4)
            by_size = f"{by_type}.filter_by(lambda {var}: abs({var}.{quantity} - {_n(size)}) < {_n(tolerance)})"
        # The axes to sort along: the one it is across or along first, then Z, X, Y.
        axes = list(dict.fromkeys([a for a in (axis, 2, 0, 1) if a is not None]))

        # 1. Type and direction, when that alone picks it.
        for prefix in (by_axis, by_type):
            if prefix:
                yield BY_GEOMETRY, (prefix, "only")
        # 2. The extreme of those along an axis.
        for prefix in (by_axis, by_type):
            if prefix:
                for a in axes:
                    for end in (-1, 0):
                        yield BY_GEOMETRY, (prefix, ("end", a, end))
        for prefix in (by_axis, by_type):
            if prefix:
                for a in axes:
                    for b in axes:
                        if a != b:
                            for end in (-1, 0):
                                for end2 in (-1, 0):
                                    yield BY_GEOMETRY, (prefix, ("group", a, end, b, end2))
        # 3. A value it has: where it is, its radius, its size, alone or with an extreme.
        for prefix in (at, by_radius, by_size):
            if prefix:
                yield BY_GEOMETRY, (prefix, "only")
        for prefix in (by_radius, by_size):
            if prefix:
                for a in axes:
                    for end in (-1, 0):
                        yield BY_GEOMETRY, (prefix, ("end", a, end))
        for prefix in (by_radius, by_size):
            if prefix:
                for a in axes:
                    for b in axes:
                        if a != b:
                            for end in (-1, 0):
                                for end2 in (-1, 0):
                                    yield BY_GEOMETRY, (prefix, ("group", a, end, b, end2))
        # 4. Its place in a sort: the next edit may change it.
        for prefix in (by_axis, by_radius, by_type, by_size):
            if prefix:
                for a in axes:
                    yield BY_ORDER, (prefix, ("order", a))

    def _selection(self, prefix: str) -> list[Any] | None:
        """The shapes a selection gives, or None when the target is not among them (nothing built on it can pick it)."""
        if prefix not in self.prefixes:
            items = list(eval(prefix, self.globals))  # noqa: S307 - the text is made here, of nothing a caller gave
            self.prefixes[prefix] = items if any(self._is_target(s) for s in items) else None
        return self.prefixes[prefix]

    def _is_target(self, shape: Any) -> bool:
        return bool(shape.wrapped.IsSame(self.target))

    def _try(self, prefix: str, terminal: Any) -> str | None:
        items = self._selection(prefix)
        if items is None:
            return None
        if terminal == "only":
            expression = f"{prefix}[0]"
            return expression if len(items) == 1 and self._picks(expression) else None
        kind, axis = terminal[0], terminal[1]
        if len(items) < 2:
            return None
        if kind == "group":
            return self._group(prefix, items, terminal)
        keys = [_coordinate(s, axis) for s in items]
        mine = next(i for i, s in enumerate(items) if self._is_target(s))
        # A tie with any other makes a place in the sort, or an end of it, arbitrary.
        if any(abs(k - keys[mine]) <= TIE for i, k in enumerate(keys) if i != mine):
            return None
        rank = sum(1 for k in keys if k < keys[mine])
        if kind == "end":
            end = terminal[2]
            if rank != (0 if end == 0 else len(items) - 1):
                return None
            index = end
        else:
            index = rank if rank <= len(items) - 1 - rank else rank - len(items)
        expression = f"{prefix}.sort_by(Axis.{_AXES[axis]})[{index}]"
        return expression if self._picks(expression) else None

    def _group(self, prefix: str, items: list[Any], terminal: Any) -> str | None:
        """The extreme along ``b`` of the group that is the extreme along ``a``: both ends strict, the group a part of
        the selection and not all of it."""
        _, a, end, b, end2 = terminal
        keys = [_coordinate(s, a) for s in items]
        mine = next(i for i, s in enumerate(items) if self._is_target(s))
        group = [i for i, k in enumerate(keys) if abs(k - keys[mine]) <= TIE]
        outside = [keys[i] for i in range(len(items)) if i not in group]
        if not outside:
            return None
        if end == 0 and any(k <= keys[mine] + TIE for k in outside):
            return None
        if end == -1 and any(k >= keys[mine] - TIE for k in outside):
            return None
        across = {i: _coordinate(items[i], b) for i in group}
        if any(abs(k - across[mine]) <= TIE for i, k in across.items() if i != mine):
            return None
        if len(group) < 2 or (across[mine] != (min if end2 == 0 else max)(across.values())):
            return None
        expression = f"{prefix}.group_by(Axis.{_AXES[a]})[{end}].sort_by(Axis.{_AXES[b]})[{end2}]"
        return expression if self._picks(expression) else None

    def _picks(self, expression: str) -> bool:
        """Whether the expression, evaluated, gives this shape. The check of every form: what is told is what it did."""
        try:
            return self._is_target(eval(expression, self.globals))  # noqa: S307 - as above
        except Exception:
            return False


def _coordinate(shape: Any, axis: int) -> float:
    center = shape.center()
    return float((center.X, center.Y, center.Z)[axis])


def _n(value: float) -> str:
    """A number as the expression writes it: to ``_DECIMALS`` decimals, no trailing zeros, never ``-0``."""
    text = f"{round(float(value), _DECIMALS):.{_DECIMALS}f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text
