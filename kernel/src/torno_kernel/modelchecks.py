"""The model's own checks: an optional ``checks(p)``, declared by the model and measured by torno.

A declaration is a dict in torno's vocabulary, not a predicate: torno measures it with the kernel it has, so
a result says whether it is exact. ``validate`` reads the declarations (their shape and the names they use, no
geometry) when the model is loaded; ``run`` measures them once the build is tessellated. A check that does not
pass never fails the build; one that is malformed does, as a bad ``groups(p)`` does.

Refs are part names and group names (never ``F12``, which changes every build). A group stands for its parts.
"""

import math
import time
from typing import Any

# What the checks may take, s, of a build; past it the rest are told as not run.
BUDGET = 10.0
# At most so many declarations, and so many pairs of parts for one that names groups.
MOST_CHECKS = 100
MOST_PAIRS = 100
# A value this near a bound is on it: arithmetic in the model (p.clearance - 0.05) is not exact.
_SLACK = 1e-9

_BOUNDS = ("min", "max", "equals", "expected", "tolerance", "percent")
_COMMON = ("name", "kind", "layout")
# kind -> (keys it takes besides the common ones, the part refs it names, the unit of its value)
_KINDS: dict[str, tuple[tuple[str, ...], tuple[str, ...], str]] = {
    "clearance": (("a", "b", *_BOUNDS), ("a", "b"), "mm"),
    "overlap": (("a", "b", *_BOUNDS), ("a", "b"), "mm³"),
    "solids": (("a", *_BOUNDS), ("a",), "solids"),
    "volume": (("a", *_BOUNDS), ("a",), "mm³"),
    "thin": (("a", "min"), ("a",), "mm"),
    "overhang": (("a", "angle"), ("a",), "mm²"),
    "mesh": (("a",), ("a",), "open edges"),
    "bed": (("size",), (), "mm"),
    "interference": ((), (), "pairs"),
}
# The kinds that must say what they want: the others want none (nothing shared, nothing open, nothing over).
_WANT_BOUNDS = ("clearance", "solids", "volume")


class Malformed(Exception):
    """A declaration is not one. The message says which and how."""


def kinds() -> tuple[str, ...]:
    """The kinds a declaration may be of: those of ``check`` that fit here, and ``solids`` and ``volume``."""
    from . import checks

    return tuple(k for k in _KINDS if k in ("solids", "volume") or k in checks.KINDS)


def validate(
    made: Any, layouts: dict[str, dict[str, Any]], groups: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """What ``checks(p)`` returned, as the declarations it holds, in its order. Raises ``Malformed``."""
    if not isinstance(made, (list, tuple)):
        raise Malformed(f"checks() must return a list of declarations, got {type(made).__name__}")
    if len(made) > MOST_CHECKS:
        raise Malformed(f"checks() returned {len(made)} declarations; at most {MOST_CHECKS}")
    parts = list(dict.fromkeys(name for layout in layouts.values() for name in layout))
    names = {g["name"] for g in groups}
    known = ", ".join([*parts, *sorted(names)])
    allowed = kinds()
    told, seen = [], set()
    for i, declaration in enumerate(made):
        where = f"checks() #{i + 1}"
        if not isinstance(declaration, dict):
            raise Malformed(f"{where} must be a dict, got {type(declaration).__name__}")
        name = declaration.get("name")
        if not isinstance(name, str) or not name.strip():
            raise Malformed(f"{where} needs a name, a string")
        where = f"checks() {name!r}"
        if name in seen:
            raise Malformed(f"{where}: two checks have this name")
        seen.add(name)
        kind = declaration.get("kind")
        if kind not in allowed:
            raise Malformed(f"{where}: kind must be one of {', '.join(allowed)}, got {kind!r}")
        takes, refs, _ = _KINDS[kind]
        extra = [k for k in declaration if k not in (*_COMMON, *takes)]
        if extra:
            raise Malformed(f"{where}: {kind} does not take {', '.join(map(repr, extra))}; it takes {', '.join(takes) or 'nothing more'}")
        layout = declaration.get("layout")
        if layout is not None and layout not in layouts:
            raise Malformed(f"{where}: no layout {layout!r}; the layouts are {', '.join(layouts)}")
        for key in refs:
            ref = declaration.get(key)
            if not isinstance(ref, str):
                raise Malformed(f"{where}: {kind} needs {key}, the name of a part or a group")
            if ref not in parts and ref not in names:
                raise Malformed(f"{where}: {key} names {ref!r}, which is no part or group; they are {known}")
        if "equals" in takes:
            _bounds(declaration, where, required=kind in _WANT_BOUNDS)
        if kind == "thin":
            least = declaration.get("min")
            if not _number(least) or not 0 < least < 1e6:
                raise Malformed(f"{where}: thin needs min, the least wall in mm, a number above 0")
        if kind == "overhang" and "angle" in declaration:
            angle = declaration["angle"]
            if not _number(angle) or not 0 < angle < 90:
                raise Malformed(f"{where}: angle is degrees from vertical, above 0 and below 90")
        if kind == "bed":
            size = declaration.get("size")
            if (
                not isinstance(size, (list, tuple))
                or len(size) != 3
                or not all(_number(s) and 0 < s < 1e6 for s in size)
            ):
                raise Malformed(f"{where}: bed needs size, the bed's [x, y, z] in mm, three numbers above 0")
        told.append(_plain(declaration))
    return told


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _plain(declaration: dict[str, Any]) -> dict[str, Any]:
    """The declaration as JSON says it: tuples as lists."""
    return {k: list(v) if isinstance(v, tuple) else v for k, v in declaration.items()}


def _bounds(declaration: dict[str, Any], where: str, required: bool) -> tuple[float | None, float | None]:
    """The least and the most a value may be, from ``min``/``max``, ``equals``, or ``expected`` with
    ``tolerance`` (mm, or the unit of the kind) or ``percent``."""
    given = {k: declaration[k] for k in _BOUNDS if k in declaration}
    for key, value in given.items():
        if not _number(value):
            raise Malformed(f"{where}: {key} must be a number, got {value!r}")
    for key in ("tolerance", "percent"):
        if key in given and given[key] < 0:
            raise Malformed(f"{where}: {key} is not below 0")
    if "equals" in given and len(given) > 1:
        raise Malformed(f"{where}: equals stands alone")
    if "expected" in given:
        if ("tolerance" in given) == ("percent" in given):
            raise Malformed(f"{where}: expected takes tolerance or percent, one of them")
        if set(given) - {"expected", "tolerance", "percent"}:
            raise Malformed(f"{where}: expected takes no min or max")
        want = given["expected"]
        slack = given["tolerance"] if "tolerance" in given else abs(want) * given["percent"] / 100
        return want - slack, want + slack
    if "tolerance" in given or "percent" in given:
        raise Malformed(f"{where}: tolerance and percent go with expected")
    if "equals" in given:
        return given["equals"], given["equals"]
    low, high = given.get("min"), given.get("max")
    if low is None and high is None:
        if required:
            raise Malformed(f"{where}: say what is wanted: min and/or max, equals, or expected with tolerance")
        return None, None
    if low is not None and high is not None and low > high:
        raise Malformed(f"{where}: min {low} is above max {high}")
    return low, high


def wanted(declaration: dict[str, Any]) -> tuple[float | None, float | None]:
    """The bounds a declaration asks for. The kinds with none ask for nothing (0) or, ``thin``, ``min``."""
    kind = declaration["kind"]
    if kind == "thin":
        return declaration["min"], None
    low, high = _bounds(declaration, "", required=False) if "equals" in _KINDS[kind][0] else (None, None)
    if low is None and high is None and kind not in _WANT_BOUNDS:
        return None, 0.0
    return low, high


def run(
    declarations: list[dict[str, Any]],
    shapes: dict[str, Any],
    groups: list[dict[str, Any]],
    kept: dict[Any, Any] | None,
    budget: float = BUDGET,
) -> list[dict[str, Any]]:
    """Measure every declaration, in order. Never raises: what cannot be measured is told in the result.

    Each result has the declaration's ``name`` and ``kind``, the ``layout`` it was measured in, ``status``
    (``pass``, ``fail``, ``error`` for a check that could not be measured, ``not run`` past the ``budget``),
    the ``declared`` dict as written, and, once measured, the ``value`` (null when nothing was found to
    measure), its ``unit``, the least and the most it may be (``min``, ``max``: null for no bound), whether it is
    ``exact`` and ``how``. An ``error`` and a ``not run`` have a ``reason``.
    """
    held: dict[Any, Any] = {} if kept is None else kept
    started = time.monotonic()
    members = {g["name"]: list(g["parts"]) for g in groups}
    layouts: dict[str, list[str]] = {}
    for key in shapes:
        layout, part = key.split(":", 1)
        layouts.setdefault(layout, []).append(part)
    results = []
    for declaration in declarations:
        base = {"name": declaration["name"], "kind": declaration["kind"], "declared": declaration}
        if time.monotonic() - started > budget:
            results.append({**base, "status": "not run", "reason": f"the {budget:g} s for checks ran out"})
            continue
        try:
            results.append({**base, **_measure(declaration, shapes, layouts, members, held)})
        except _Cannot as e:
            results.append({**base, "status": "error", "reason": str(e)})
        except Exception as e:
            from .queries import QueryError

            reason = e.message if isinstance(e, QueryError) else f"{type(e).__name__}: {e}"
            results.append({**base, "status": "error", "reason": reason})
    return results


class _Cannot(Exception):
    """A check that cannot be measured, and why."""


def _expand(ref: str, layout: str, layouts: dict[str, list[str]], members: dict[str, list[str]]) -> list[str]:
    """The parts a ref stands for in a layout: itself, or a group's parts that the layout has."""
    have = layouts[layout]
    found = [ref] if ref in have else [p for p in members.get(ref, []) if p in have]
    if not found:
        raise _Cannot(f"{ref} has no part in {layout}; its parts are {', '.join(have)}")
    return found


def _layout(declaration: dict[str, Any], layouts: dict[str, list[str]], members: dict[str, list[str]]) -> str:
    """The layout asked, else the first (assembly first) that has every part named; the print layout for a
    check of printing, when it has them."""
    if declaration.get("layout"):
        return declaration["layout"]
    kind = declaration["kind"]
    names = [declaration[k] for k in ("a", "b") if k in declaration]
    order = list(layouts)
    if kind in ("thin", "overhang", "mesh", "bed") and "print" in layouts:
        order.sort(key=lambda layout: layout != "print")
    for layout in order:
        if all(any(p in layouts[layout] for p in ([n] if n in layouts[layout] else members.get(n, []))) for n in names):
            return layout
    raise _Cannot(f"no layout has {' and '.join(names)}; the layouts are {', '.join(layouts)}")


def _measure(
    declaration: dict[str, Any],
    shapes: dict[str, Any],
    layouts: dict[str, list[str]],
    members: dict[str, list[str]],
    held: dict[Any, Any],
) -> dict[str, Any]:
    from . import checks, measure, topo
    from .queries import QueryError

    kind = declaration["kind"]
    layout = _layout(declaration, layouts, members)
    unit = _KINDS[kind][2]
    low, high = wanted(declaration)

    def ask(args: dict[str, Any]) -> dict[str, Any]:
        return checks.check(shapes, {"layout": layout, **args}, held)

    ones = _expand(declaration["a"], layout, layouts, members) if "a" in declaration else []
    others = _expand(declaration["b"], layout, layouts, members) if "b" in declaration else []
    exact, how, ok = True, "", None
    value: float | None
    if kind in ("clearance", "overlap"):
        pairs = list(dict.fromkeys((a, b) for a in ones for b in others if a != b))
        if not pairs:
            raise _Cannot(f"a and b are the same part: {declaration['a']} and {declaration['b']}")
        if len(pairs) > MOST_PAIRS:
            raise _Cannot(f"{len(pairs)} pairs of parts; at most {MOST_PAIRS}")
        if kind == "clearance":
            told = [ask({"kind": kind, "a": a, "b": b}) for a, b in pairs]
            value = min(t["distance"] for t in told)
            how = "least distance between the parts" + ("" if len(pairs) == 1 else f", over {len(pairs)} pairs")
        else:
            told = [ask({"kind": kind, "a": a, "b": b}) for a, b in pairs]
            value = math.fsum(t["volume"] for t in told)
            value = 0.0 if value < 1e-6 else value
            exact = all(t["volumeExact"] for t in told)
            how = "volume the parts share" + ("" if exact else "; approximate")
    elif kind == "solids":
        value = float(sum(len(topo.solids(shapes[f"{layout}:{a}"])) for a in ones))
        how = "solids the part has"
    elif kind == "volume":
        told = [
            measure.measure(shapes, {"kind": "volume", "a": {"ref": f"{layout}:{a}"}}, held) for a in ones
        ]
        value = math.fsum(t["value"] for t in told)
        exact = all(t["exact"] for t in told)
        how = "volume of the solids" + ("" if exact else "; approximate")
    elif kind == "thin":
        told = [ask({"kind": kind, "a": a, "min": declaration["min"]}) for a in ones]
        found = sum(t["count"] for t in told)
        walls = [t["thinnest"]["value"] for t in told if t["thinnest"]]
        value = min(walls) if walls else None
        exact = False
        complete = all(t["sampling"]["complete"] for t in told)
        ok = found == 0 and complete
        how = "thinnest wall found by sampling; none found is not none there"
        if not complete:
            how += "; the time ran out before every face was measured"
    elif kind == "overhang":
        told = [ask({"kind": kind, "a": a, "angle": declaration.get("angle", 45)}) for a in ones]
        value = math.fsum(t["area"] for t in told)
        exact = all(t["exact"] for t in told)
        how = f"area of faces facing down steeper than {declaration.get('angle', 45):g}° from vertical"
        ok = sum(t["count"] for t in told) == 0
    elif kind == "mesh":
        told = [ask({"kind": kind, "a": a}) for a in ones]
        value = float(sum(t["openEdges"] for t in told))
        how = "edges of one triangle only in the mesh the part is drawn with"
        ok = all(t["watertight"] for t in told)
    elif kind == "bed":
        told = [ask({"kind": kind, "size": declaration["size"]})]
        value = max(told[0]["over"])
        exact = told[0]["exact"]
        how = "how far the layout's box is over the bed, at most along an axis"
        ok = bool(told[0]["fits"])
    elif kind == "interference":
        told = [ask({"kind": kind})]
        value = float(len(told[0]["interfering"]))
        complete = told[0]["sampling"]["complete"]
        how = "pairs of parts that share volume" + ("" if complete else "; the time ran out before every pair was cut")
        ok = value == 0 and complete
    else:  # pragma: no cover - validate refuses the others
        raise QueryError("bad_request", f"unknown kind {kind}")
    if ok is None:
        ok = value is not None and _within(value, low, high)
    return {
        "status": "pass" if ok else "fail",
        "layout": layout,
        "value": value,
        "unit": unit,
        "min": low,
        "max": high,
        "exact": exact,
        "how": how,
    }


def _within(value: float, low: float | None, high: float | None) -> bool:
    slack = _SLACK * max(1.0, abs(value))
    return (low is None or value >= low - slack) and (high is None or value <= high + slack)
