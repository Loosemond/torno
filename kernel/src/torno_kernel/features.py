"""What a part is made of, as a person names it: the ``features`` query. Holes and bosses.

Of the shapes as the build placed them, in the layout asked, millimetres, Z up. A feature is found on the
B-rep's own adjacency, with no boolean and no mesh: faces that are cylinders, cones or tori about one axis,
that meet at an edge (or on the plane of a step), make a hole when the material is outside them and a boss when
it is inside. Every number told is a radius, an axis, an angle or the distance between a plane and a line (the
point where the axis meets a plane), and so exact; what is taken from a face that is not a plane (the mouth of a
hole on a curved face) is told with ``exact`` false and ``how``. Faces named by ref are of the part, in the
kernel's order (``topo``), as ``describe`` takes them.
"""

import math
import time
from typing import Any

from . import extent, topo
from .ocp import (
    TopAbs_EDGE,
    TopAbs_FACE,
    TopExp,
    TopTools_IndexedDataMapOfShapeListOfShape,
    TopTools_IndexedMapOfShape,
)
from .queries import QueryError, need_part, need_solid

KINDS = ("hole", "boss")
# What may be asked, s, of the 30 a query has; past it the components left are counted, never told as a no.
BUDGET = 10.0
# At most so many of a kind are told; the rest are counted.
MAX_FEATURES = 100
# Two axes are one when the point of one is this near the other, mm, and they are parallel to this (sine).
ON_AXIS = 1e-5
PARALLEL = 1e-7
# A full turn, with what a face's parameter range may be short of one.
TURN = 2 * math.pi - 1e-6
# Edges are sampled at this many places.
SAMPLES = 9
# A normal this near perpendicular to the axis is none of an end's.
FLAT = 1e-6
_ROUND = {"CYLINDER", "CONE", "TORUS"}
_ANALYTIC = {"PLANE", "CYLINDER", "CONE", "SPHERE", "TORUS"}

Vec = tuple[float, float, float]


def features(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    """Answer ``features``: ``args`` are ``layout``, the part and ``kinds`` (a list of ``KINDS``, default all).

    - ``holes``: a hole is a run of coaxial concave cylinders, cones and tori that goes right round. It has its
      ``diameter`` (the least of its cylinders; of a cone alone the least end), the ``axis`` pointing into the
      part from where it opens, ``entry`` (the axis where it meets the plane it opens in) and ``entryRef`` (that
      face), ``end`` (``through``, ``blind``, ``enclosed`` or ``unknown``), ``depth`` along the axis, ``bottom``
      (``flat``, ``cone``, ``round`` or ``other``) of a blind one, its ``shape`` (``plain``, ``counterbore``,
      ``countersink``, ``rounded``, ``stepped`` or ``tapered``) and its ``steps`` from the entry.
    - ``bosses``: the same for convex ones that stand on a face and end in another: ``diameter``, ``height``,
      ``axis`` pointing up from the base, ``base`` and ``baseRef``, ``top`` and ``topRef``.

    Each has ``exact`` and, when false, ``how``. ``kept`` is the worker's: the analysis of a part is made once.
    """
    layout, name = args.get("layout"), args.get("part")
    if not isinstance(layout, str) or not isinstance(name, str):
        raise QueryError("bad_request", "features needs args.layout and args.part, the name of a part of it, both strings")
    kinds = args.get("kinds")
    if kinds is None:
        kinds = list(KINDS)
    if not isinstance(kinds, list) or not kinds or not all(k in KINDS for k in kinds):
        raise QueryError("bad_request", f"features takes kinds, a list of {', '.join(KINDS)}")
    shape = need_part(shapes, layout, name)
    need_solid(shape, name)
    key = f"{layout}:{name}"
    found = _analysis(shape, name, key, kept)
    told: dict[str, Any] = {"part": name, "kinds": [k for k in KINDS if k in kinds], "left": {}}
    exact = True
    for kind, plural in (("hole", "holes"), ("boss", "bosses")):
        if kind not in kinds:
            continue
        items = found[plural]
        told[plural] = items[:MAX_FEATURES]
        told[f"{kind}Count"] = len(items)
        told["left"][plural] = max(0, len(items) - MAX_FEATURES)
        exact = exact and all(item["exact"] for item in items)
    told["notFeatures"] = found["notFeatures"]
    told["exact"] = exact
    told["how"] = (
        "from the B-rep: diameters, angles, axes and the places where an axis meets a plane; "
        "only cylinders, cones and tori that go right round are recognised"
    )
    told["complete"] = found["complete"]
    told["seconds"] = found["seconds"]
    return told


def _within(steps: list[dict[str, Any]], length: float) -> list[dict[str, Any]]:
    """The steps of a run cut to the length it has between the faces it meets: a mouth on a slant reaches past it."""
    for step in steps:
        step["from"] = min(max(step["from"], 0.0), length)
        step["to"] = min(max(step["to"], 0.0), length)
    return [s for s in steps if s["to"] - s["from"] > 1e-9 or s["type"] == "cone"]


def _join_crossings(holes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Two plain holes of one diameter on one axis that face each other and end in the same crossed hole are one.

    A hole drilled across another comes in two faces, one each side of the one it crosses; it is one hole
    through the part, and is told so, with the faces of the hole it ``crosses``.
    """
    owner = {ref: k for k, h in enumerate(holes) for ref in h["faces"]}

    def outer(h: dict[str, Any]) -> tuple[Vec, str | None, int | None] | None:
        """The end of the hole that is not in another hole: its point, its face, and the hole the other end is in."""
        if h["shape"] != "plain" or h["end"] != "through" or "exitRef" not in h or "entryRef" not in h:
            return None
        axis, entry = tuple(h["axis"]), tuple(h["entry"])
        far = _add(entry, axis, h["depth"])  # type: ignore[arg-type]
        if h["exitRef"] in owner and h["entryRef"] not in owner:
            return entry, h["entryRef"], owner[h["exitRef"]]  # type: ignore[return-value]
        if h["entryRef"] in owner and h["exitRef"] not in owner:
            return far, h["exitRef"], owner[h["entryRef"]]  # type: ignore[return-value]
        return None

    gone: set[int] = set()
    joined: list[dict[str, Any]] = []
    for k, h in enumerate(holes):
        if k in gone:
            continue
        mine = outer(h)
        if mine is not None:
            for m in range(k + 1, len(holes)):
                g, there = holes[m], outer(holes[m])
                if m in gone or there is None or there[2] != mine[2] or abs(g["diameter"] - h["diameter"]) > 1e-6:
                    continue
                if abs(_dot(tuple(h["axis"]), tuple(g["axis"]))) < 1 - 1e-9:  # type: ignore[arg-type]
                    continue
                along = _sub(there[0], mine[0])
                if _norm(_cross(along, tuple(h["axis"]))) > ON_AXIS:  # type: ignore[arg-type]
                    continue
                high, low = sorted((mine, there), key=lambda e: tuple(round(c, 9) for c in reversed(e[0])), reverse=True)
                span = _norm(_sub(high[0], low[0]))
                direction = _sub(low[0], high[0])
                joined.append(
                    {
                        **h,
                        "axis": _clean(tuple(c / span for c in direction)),  # type: ignore[arg-type]
                        "entry": _clean(high[0]),
                        "entryRef": high[1],
                        "exitRef": low[1],
                        "depth": span,
                        "steps": [{"from": 0.0, "to": span, "type": "cylinder", "diameter": h["diameter"]}],
                        "faces": sorted(set(h["faces"]) | set(g["faces"])),
                        "crosses": sorted(holes[mine[2]]["faces"]),  # type: ignore[index]
                        "exact": bool(h["exact"] and g["exact"]),
                    }
                )
                gone |= {k, m}
                break
        if k not in gone:
            joined.append(h)
    return joined


def _analysis(shape: Any, name: str, key: str, kept: dict[Any, Any] | None) -> dict[str, Any]:
    if kept is not None and ("features", key) in kept:
        return kept["features", key]
    found = _Part(shape, name).analyse()
    if kept is not None and found["complete"]:
        kept["features", key] = found
    return found


# Small vector algebra on tuples: a feature is a handful of numbers, and numpy is for arrays.


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add(a: Vec, b: Vec, k: float = 1.0) -> Vec:
    return (a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2])


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a: Vec) -> float:
    return math.sqrt(_dot(a, a))


def _xyz(p: Any) -> Vec:
    return (float(p.X()), float(p.Y()), float(p.Z()))


def _clean(v: Vec) -> list[float]:
    # Adding 0.0 turns -0.0 into 0.0; what a rotation leaves of a zero is none.
    return [0.0 if abs(c) < 1e-9 else float(c) + 0.0 for c in v]


def _kind(adaptor: Any) -> str:
    return extent._kind(adaptor)


class _Node:
    """A face that is round about an axis, and which side of it the material is."""

    def __init__(self, index: int, kind: str, origin: Vec, axis: Vec, sign: int, wrap: float, shape: Any) -> None:
        self.index = index
        self.kind = kind
        self.origin = origin
        self.axis = axis
        self.sign = sign  # -1: the material is outside the face (a hole), 1: inside (a boss)
        self.wrap = wrap
        self.shape = shape  # (radius, semi-angle, ref radius, minor radius) as the surface has them


class _Part:
    def __init__(self, shape: Any, name: str) -> None:
        self.name = name
        self.wrapped = getattr(shape, "wrapped", shape)
        self.faces = topo.faces(self.wrapped)
        self.index = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(self.wrapped, TopAbs_FACE, self.index)
        self.around = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(self.wrapped, TopAbs_EDGE, TopAbs_FACE, self.around)
        self._adaptors: dict[int, Any] = {}
        self._edges: dict[int, list[Any]] = {}

    # Faces and edges

    def adaptor(self, i: int) -> Any:
        from OCP.BRepAdaptor import BRepAdaptor_Surface

        if i not in self._adaptors:
            self._adaptors[i] = BRepAdaptor_Surface(self.faces[i])
        return self._adaptors[i]

    def edges_of(self, i: int) -> list[Any]:
        """The edges of face ``i`` that bound it: not a seam (it has it twice) and not a pole."""
        from OCP.BRep import BRep_Tool

        if i not in self._edges:
            face = self.faces[i]
            self._edges[i] = [
                e for e in topo.edges(face) if not BRep_Tool.Degenerated_s(e) and not BRep_Tool.IsClosed_s(e, face)
            ]
        return self._edges[i]

    def has_pole(self, i: int) -> bool:
        from OCP.BRep import BRep_Tool

        return any(BRep_Tool.Degenerated_s(e) for e in topo.edges(self.faces[i]))

    def neighbours(self, edge: Any, i: int) -> list[int]:
        """The faces other than ``i`` that have ``edge``, by index."""
        if not self.around.Contains(edge):
            return []
        found = {self.index.FindIndex(f) - 1 for f in self.around.FindFromKey(edge)}
        found.discard(i)
        return sorted(found - {-1})

    def samples(self, edge: Any) -> list[Vec]:
        from OCP.BRepAdaptor import BRepAdaptor_Curve

        curve = BRepAdaptor_Curve(edge)
        first, last = curve.FirstParameter(), curve.LastParameter()
        return [_xyz(curve.Value(first + (last - first) * k / (SAMPLES - 1))) for k in range(SAMPLES)]

    def normal(self, i: int, point: Vec) -> Vec | None:
        """The outward unit normal of face ``i`` where ``point`` projects on its surface."""
        from OCP.BRep import BRep_Tool
        from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
        from OCP.gp import gp_Pnt, gp_Vec

        face = self.faces[i]
        try:
            projected = GeomAPI_ProjectPointOnSurf(gp_Pnt(*point), BRep_Tool.Surface_s(face))
            if projected.NbPoints() == 0:
                return None
            u, v = projected.LowerDistanceParameters()
        except Exception:
            return None
        return self._normal_at(i, u, v)

    def _normal_at(self, i: int, u: float, v: float) -> Vec | None:
        from OCP.gp import gp_Pnt, gp_Vec

        at, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
        self.adaptor(i).D1(u, v, at, du, dv)
        n = du.Crossed(dv)
        size = n.Magnitude()
        if size < 1e-12:
            return None
        sign = -1.0 if str(self.faces[i].Orientation()).endswith("REVERSED") else 1.0
        return (sign * n.X() / size, sign * n.Y() / size, sign * n.Z() / size)

    # The analysis

    def analyse(self) -> dict[str, Any]:
        from OCP.BRepTools import BRepTools

        started = time.monotonic()
        nodes: dict[int, _Node] = {}
        freeform = 0
        for i, face in enumerate(self.faces):
            kind = _kind(self.adaptor(i))
            if kind not in _ANALYTIC:
                freeform += 1
            elif kind in _ROUND:
                node = self._node(i, kind, BRepTools)
                if node is not None:
                    nodes[i] = node
        components = self._components(nodes)
        holes: list[dict[str, Any]] = []
        bosses: list[dict[str, Any]] = []
        arcs = free = 0
        complete = True
        for component in components:
            if time.monotonic() - started > BUDGET:
                complete = False
                break
            members = [nodes[i] for i in component]
            if not any(n.kind in ("CYLINDER", "CONE") for n in members):
                continue
            if not self._wraps(members):
                arcs += sum(1 for n in members if n.kind == "CYLINDER")
                continue
            told = self._feature(members, set(component), nodes)
            if told is None:
                continue
            if told == "free":
                free += 1
            elif members[0].sign < 0:
                holes.append(told)
            else:
                bosses.append(told)
        holes = _join_crossings(holes)
        for items in (holes, bosses):
            items.sort(key=lambda f: (f["entry"][2] if "entry" in f else f["base"][2], f["faces"][0]))
        return {
            "holes": holes,
            "bosses": bosses,
            "notFeatures": {"arcs": arcs, "freeCylinders": free, "freeformFaces": freeform},
            "complete": complete,
            "seconds": time.monotonic() - started,
        }

    def _node(self, i: int, kind: str, tools: Any) -> "_Node | None":
        """Face ``i`` as a node about its axis, or None when it is not clearly on either side of one."""
        ad = self.adaptor(i)
        if kind == "CYLINDER":
            s = ad.Cylinder()
            axis, origin, shape = s.Axis(), s.Location(), (s.Radius(), 0.0, 0.0, 0.0)
        elif kind == "CONE":
            s = ad.Cone()
            axis, origin, shape = s.Axis(), s.Location(), (0.0, s.SemiAngle(), s.RefRadius(), 0.0)
        else:
            s = ad.Torus()
            axis, origin, shape = s.Axis(), s.Location(), (s.MajorRadius(), 0.0, 0.0, s.MinorRadius())
        a = _xyz(axis.Direction())
        o = _xyz(origin)
        u0, u1, v0, v1 = tools.UVBounds_s(self.faces[i])
        n = self._normal_at(i, (u0 + u1) / 2, (v0 + v1) / 2)
        if n is None:
            return None
        from OCP.gp import gp_Pnt

        at = gp_Pnt()
        ad.D0((u0 + u1) / 2, (v0 + v1) / 2, at)
        p = _sub(_xyz(at), o)
        radial = _sub(p, tuple(c * _dot(p, a) for c in a))  # type: ignore[arg-type]
        side = _dot(n, radial)
        if abs(side) < 1e-9:
            return None
        return _Node(i, kind, o, a, -1 if side < 0 else 1, abs(u1 - u0), shape)

    def _coaxial(self, a: _Node, b: _Node) -> bool:
        if _norm(_cross(a.axis, b.axis)) > PARALLEL:
            return False
        d = _sub(b.origin, a.origin)
        off = _sub(d, tuple(c * _dot(d, a.axis) for c in a.axis))  # type: ignore[arg-type]
        return _norm(off) <= ON_AXIS

    def _components(self, nodes: dict[int, _Node]) -> list[list[int]]:
        """Nodes joined where they meet at an edge, or each side of a plane across their axis, about one axis."""
        parent = {i: i for i in nodes}

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        def join(i: int, j: int) -> None:
            parent[find(i)] = find(j)

        steps: dict[int, list[int]] = {}
        for i, node in nodes.items():
            for edge in self.edges_of(i):
                for j in self.neighbours(edge, i):
                    other = nodes.get(j)
                    if other is not None:
                        if other.sign == node.sign and self._coaxial(node, other):
                            join(i, j)
                    elif _kind(self.adaptor(j)) == "PLANE":
                        steps.setdefault(j, []).append(i)
        for j, around in steps.items():
            n = self._normal_at(j, 0.0, 0.0)
            if n is None:
                continue
            across = [i for i in set(around) if abs(abs(_dot(n, nodes[i].axis)) - 1) < 1e-9]
            for i in across[1:]:
                if nodes[i].sign == nodes[across[0]].sign and self._coaxial(nodes[across[0]], nodes[i]):
                    join(across[0], i)
        groups: dict[int, list[int]] = {}
        for i in nodes:
            groups.setdefault(find(i), []).append(i)
        return [sorted(g) for g in groups.values()]

    @staticmethod
    def _wraps(members: list[_Node]) -> bool:
        """Whether every surface of the run (faces alike in kind and size taken together) goes right round."""
        turned: dict[tuple[Any, ...], float] = {}
        for n in members:
            key = (n.kind, *(round(c, 6) for c in n.shape))
            turned[key] = turned.get(key, 0.0) + n.wrap
        return all(t >= TURN for t in turned.values())

    def _feature(self, members: list[_Node], faces: set[int], nodes: dict[int, _Node]) -> "dict[str, Any] | str | None":
        first = next(n for n in members if n.kind in ("CYLINDER", "CONE"))
        a, o = first.axis, first.origin
        # Where the run lies along its axis: the points of its boundary, and of its poles.
        ts: list[float] = []
        free: list[tuple[Any, int, int, list[float]]] = []  # (edge, own face, neighbour, t at its samples)
        links = self._links(members, faces, a)
        for n in members:
            for edge in self.edges_of(n.index):
                t = [_dot(_sub(p, o), a) for p in self.samples(edge)]
                ts += t
                others = self.neighbours(edge, n.index)
                if any(j in faces or j in links for j in others) or not others:
                    continue
                free.append((edge, n.index, others[0], t))
        ts += [_dot(_sub(_xyz(self._apex(n)), o), a) for n in members if n.kind == "CONE" and self.has_pole(n.index)]
        if not ts:
            return None
        low, high = min(ts), max(ts)
        tol = 1e-6 * (1 + high - low)
        sides: dict[str, list[tuple[int, float, Vec | None, float]]] = {"low": [], "high": []}
        for edge, _own, j, t in free:
            side = "high" if max(t) >= high - tol else "low" if min(t) <= low + tol else None
            if side is None:
                continue
            outward = a if side == "high" else (-a[0], -a[1], -a[2])
            mid = self.samples(edge)[SAMPLES // 2]
            n = self.normal(j, mid)
            if n is None:
                continue
            sides[side].append((j, _dot(n, outward), n, 0.0))
        tips = {"low": None, "high": None}
        for n in members:
            if n.kind == "CONE" and self.has_pole(n.index):
                t = _dot(_sub(_xyz(self._apex(n)), o), a)
                tips["high" if abs(t - high) <= tol else "low" if abs(t - low) <= tol else "high"] = t  # type: ignore[assignment]
        if members[0].sign < 0:
            return self._hole(members, faces, o, a, low, high, sides, tips)
        return self._boss(members, faces, o, a, low, high, sides, tips)

    def _links(self, members: list[_Node], faces: set[int], a: Vec) -> set[int]:
        """The planes across the axis that two surfaces of the run meet on: its steps."""
        seen: dict[int, set[tuple[Any, ...]]] = {}
        for n in members:
            for edge in self.edges_of(n.index):
                for j in self.neighbours(edge, n.index):
                    if j not in faces and _kind(self.adaptor(j)) == "PLANE":
                        seen.setdefault(j, set()).add((n.kind, *(round(c, 6) for c in n.shape)))
        links = set()
        for j, surfaces in seen.items():
            normal = self._normal_at(j, 0.0, 0.0)
            if len(surfaces) >= 2 and normal is not None and abs(abs(_dot(normal, a)) - 1) < 1e-9:
                links.add(j)
        return links

    def _apex(self, node: _Node) -> Any:
        return self.adaptor(node.index).Cone().Apex()

    def _hit(self, j: int, o: Vec, a: Vec, extreme: float) -> tuple[float, bool]:
        """Where along the axis it meets the surface of face ``j`` (the one nearest ``extreme``), and whether that is exact.

        A plane is met in closed form; a cylinder, cone, sphere or torus by OCC's intersection of a line with
        that analytic surface, which is as exact; of any other surface the end of the run is taken, not exact.
        """
        from OCP.BRep import BRep_Tool
        from OCP.Geom import Geom_Line
        from OCP.GeomAPI import GeomAPI_IntCS
        from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt

        ad = self.adaptor(j)
        kind = _kind(ad)
        if kind == "PLANE":
            plane = ad.Plane()
            n = _xyz(plane.Axis().Direction())
            slant = _dot(a, n)
            if abs(slant) < 1e-9:
                return extreme, False
            return _dot(_sub(_xyz(plane.Location()), o), n) / slant, True
        if kind in _ANALYTIC:
            try:
                line = Geom_Line(gp_Ax1(gp_Pnt(*o), gp_Dir(*a)))
                hits = GeomAPI_IntCS(line, BRep_Tool.Surface_s(self.faces[j]))
                found = [hits.Parameters(i)[2] for i in range(1, hits.NbPoints() + 1)] if hits.IsDone() else []
            except Exception:
                found = []
            if found:
                return min(found, key=lambda t: abs(t - extreme)), True
        return extreme, False

    def _hole(self, members, faces, o, a, low, high, sides, tips) -> dict[str, Any]:  # type: ignore[no-untyped-def]
        state: dict[str, dict[str, Any]] = {}
        for side in ("low", "high"):
            near = sides[side]
            opens = [s for s in near if s[1] > FLAT]
            shuts = [s for s in near if s[1] < -FLAT]
            extreme = low if side == "low" else high
            if opens:
                j = opens[0][0]
                t, exact = self._hit(j, o, a, extreme)
                state[side] = {"open": True, "face": j, "t": t, "exact": exact}
            elif shuts:
                j = shuts[0][0]
                t, exact = self._hit(j, o, a, extreme)
                kind = _kind(self.adaptor(j))
                state[side] = {
                    "open": False,
                    "face": j,
                    "t": t,
                    "exact": exact,
                    "bottom": "flat" if kind == "PLANE" else "round" if kind == "SPHERE" else "other",
                }
            elif tips[side] is not None:
                state[side] = {"open": False, "face": None, "t": tips[side], "exact": True, "bottom": "cone"}
            else:
                state[side] = {"open": None, "face": None, "t": extreme, "exact": False}
        opens = [s for s in ("low", "high") if state[s]["open"]]
        unknown = [s for s in ("low", "high") if state[s]["open"] is None]
        if len(opens) == 2:
            end = "through"
        elif unknown:
            end = "unknown"
        elif len(opens) == 1:
            end = "blind"
        else:
            end = "enclosed"
        # The entry is where it opens (the higher end of one that opens at both or neither).
        if len(opens) == 1:
            entry = opens[0]
        else:
            ends = {s: _add(o, a, state[s]["t"]) for s in ("low", "high")}
            entry = max(("low", "high"), key=lambda s: tuple(round(c, 9) for c in reversed(ends[s])))
        other = "low" if entry == "high" else "high"
        toward = -1.0 if entry == "high" else 1.0  # the way into the part along a
        axis = (a[0] * toward, a[1] * toward, a[2] * toward)
        t0 = state[entry]["t"]
        depth = abs(state[other]["t"] - t0)
        exact = bool(state[entry]["exact"] and state[other]["exact"] and end != "unknown")
        steps = _within(self._steps(members, o, a, t0, toward), depth)
        shape = self._shape(steps)
        told: dict[str, Any] = {
            "diameter": self._diameter(steps),
            "axis": _clean(axis),
            "entry": _clean(_add(o, a, t0)),
            "end": end,
            "depth": depth,
            "shape": shape,
            "steps": steps,
            "faces": [f"{self.name}/F{i}" for i in sorted(faces)],
            "exact": exact,
        }
        if state[entry]["open"]:
            told["entryRef"] = f"{self.name}/F{state[entry]['face']}"
        if end == "through":
            told["exitRef"] = f"{self.name}/F{state[other]['face']}"
        if end == "blind":
            told["bottom"] = state[other]["bottom"]
        decorated = self._decorate(steps, shape)
        told.update(decorated)
        if not exact:
            told["how"] = (
                "the depth is along the axis between faces that are not planes or round, so this is not exact"
                if end != "unknown"
                else "an end of it meets a face this could not tell open from shut"
            )
        return told

    def _boss(self, members, faces, o, a, low, high, sides, tips) -> "dict[str, Any] | str | None":  # type: ignore[no-untyped-def]
        state: dict[str, dict[str, Any]] = {}
        for side in ("low", "high"):
            near = sides[side]
            bases = [s for s in near if s[1] < -FLAT]
            caps = [s for s in near if s[1] > FLAT]
            extreme = low if side == "low" else high
            if bases:
                j = bases[0][0]
                t, exact = self._hit(j, o, a, extreme)
                state[side] = {"base": True, "face": j, "t": t, "exact": exact}
            elif caps:
                j = caps[0][0]
                t, exact = self._hit(j, o, a, extreme)
                state[side] = {"base": False, "face": j, "t": t, "exact": exact}
            elif tips[side] is not None:
                state[side] = {"base": False, "face": None, "t": tips[side], "exact": True}
            else:
                state[side] = {"base": None, "face": None, "t": extreme, "exact": False}
        bases = [s for s in ("low", "high") if state[s]["base"]]
        if len(bases) != 1 or any(state[s]["base"] is None for s in ("low", "high")):
            return "free" if not bases and all(state[s]["base"] is False for s in ("low", "high")) else None
        base = bases[0]
        top = "low" if base == "high" else "high"
        up = 1.0 if base == "low" else -1.0
        axis = (a[0] * up, a[1] * up, a[2] * up)
        t0 = state[base]["t"]
        steps = _within(self._steps(members, o, a, t0, up), abs(state[top]["t"] - t0))
        exact = bool(state[base]["exact"] and state[top]["exact"])
        told: dict[str, Any] = {
            "diameter": self._diameter(steps, boss=True),
            "axis": _clean(axis),
            "base": _clean(_add(o, a, t0)),
            "baseRef": f"{self.name}/F{state[base]['face']}",
            "top": _clean(_add(o, a, state[top]["t"])),
            "height": abs(state[top]["t"] - t0),
            "steps": steps,
            "faces": [f"{self.name}/F{i}" for i in sorted(faces)],
            "exact": exact,
        }
        if state[top].get("face") is not None:
            told["topRef"] = f"{self.name}/F{state[top]['face']}"
        if not exact:
            told["how"] = "the height is along the axis between faces that are not planes or round, so this is not exact"
        return told

    # What a run is made of, from the entry (or the base) in

    def _steps(self, members: list[_Node], o: Vec, a: Vec, t0: float, toward: float) -> list[dict[str, Any]]:
        merged: dict[tuple[Any, ...], dict[str, Any]] = {}
        for n in members:
            ts = [_dot(_sub(p, o), a) for edge in self.edges_of(n.index) for p in self.samples(edge)]
            if n.kind == "CONE" and self.has_pole(n.index):
                ts.append(_dot(_sub(_xyz(self._apex(n)), o), a))
            if not ts:
                continue
            s = sorted((t - t0) * toward for t in (min(ts), max(ts)))
            key = (n.kind, *(round(c, 6) for c in n.shape))
            if key in merged:
                merged[key]["from"] = min(merged[key]["from"], s[0])
                merged[key]["to"] = max(merged[key]["to"], s[1])
                continue
            step: dict[str, Any] = {"from": max(0.0, s[0]) if abs(s[0]) < 1e-9 else s[0], "to": s[1]}
            if n.kind == "CYLINDER":
                step.update(type="cylinder", diameter=2 * n.shape[0])
            elif n.kind == "CONE":
                semi, ref = n.shape[1], n.shape[2]

                def radius(t: float, n: _Node = n, ref: float = ref, semi: float = semi) -> float:
                    along = _dot(_sub(_add(o, a, t), n.origin), n.axis)
                    return abs(ref + along * math.tan(semi))

                ends = [radius(t0 + s[0] * toward), radius(t0 + s[1] * toward)]
                step.update(
                    type="cone",
                    diameters=[2 * ends[0], 2 * ends[1]],
                    angle=math.degrees(2 * abs(semi)),
                )
                if n.kind == "CONE" and self.has_pole(n.index):
                    step["tip"] = True
            else:
                step.update(type="round", radius=n.shape[3], axisRadius=n.shape[0])
            merged[key] = step
        steps = sorted(merged.values(), key=lambda s: (s["from"], s["to"]))
        for step in steps:
            step["from"] = max(0.0, step["from"]) if step["from"] > -1e-9 else step["from"]
        return steps

    @staticmethod
    def _diameter(steps: list[dict[str, Any]], boss: bool = False) -> float:
        cyl = [s for s in steps if s["type"] == "cylinder"]
        if cyl:
            if boss:
                return float(max(cyl, key=lambda s: s["to"] - s["from"])["diameter"])
            return float(min(s["diameter"] for s in cyl))
        cone = [min(s["diameters"]) for s in steps if s["type"] == "cone"]
        return float(min(cone)) if cone else 0.0

    @staticmethod
    def _shape(steps: list[dict[str, Any]]) -> str:
        cyl = [s for s in steps if s["type"] == "cylinder"]
        if not cyl:
            return "tapered"
        first = steps[0]
        diameters = sorted({round(s["diameter"], 6) for s in cyl})
        if len(diameters) == 1:
            if first["type"] == "cone" and not first.get("tip"):
                return "countersink"
            if first["type"] == "round":
                return "rounded"
            return "plain"
        if cyl[0]["diameter"] > cyl[1]["diameter"]:
            return "counterbore"
        return "stepped"

    @staticmethod
    def _decorate(steps: list[dict[str, Any]], shape: str) -> dict[str, Any]:
        cyl = [s for s in steps if s["type"] == "cylinder"]
        if shape == "counterbore":
            return {"counterbore": {"diameter": cyl[0]["diameter"], "depth": cyl[0]["to"] - cyl[0]["from"]}}
        if shape == "countersink":
            cone = steps[0]
            return {"countersink": {"diameter": max(cone["diameters"]), "angle": cone["angle"], "depth": cone["to"] - cone["from"]}}
        if shape == "rounded":
            return {"rounded": {"radius": steps[0]["radius"]}}
        return {}
