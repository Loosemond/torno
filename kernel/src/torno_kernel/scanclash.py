"""What a part is to a scan: the ``scan_clash``, ``scan_deviation`` and ``scan_section`` queries.

A scan is a mesh someone measured: nothing here is exact, and every answer
says so. Which scan points are inside a part is decided on the mesh the part
is drawn with, by counting how often a ray from the point crosses it; how far
a point is from the part is first taken from that mesh sampled every
millimetre, and, for the few points an answer names, taken again from the
B-rep. The scan is read from the ``mesh.bin`` the query names: the worker is
given paths, and never looks for a file itself.
"""

import os
import time
from typing import Any

import numpy as np

from . import scanfile, tess, topo
from .queries import QueryError, _Surface, need_part

# No more scan vertices than this are tested against a part: more are thinned to every n-th, and the answer says so.
MAX_CANDIDATES = 200_000
# No more points than this are taken again on the B-rep (16 ms each on a part of 2,600 faces).
MAX_RETAKEN = 32
MAX_CLUSTERS = 8
# Scan points inside a part are one cluster when their cells of this size, mm, touch.
CELL = 5.0
# How far apart, mm, the points are that stand for a part's surface.
SURFACE = 1.0
# Seconds a query gives itself, of the 30 the supervisor allows: what is left undone is said.
BUDGET = 15.0
BATCH = 50_000
# A ray this near, in barycentric terms, to a triangle's edge is asked again along another axis.
GRAZE = 1e-9
# How far aside, mm, a point is asked from again when its ray grazed an edge: along no axis and no diagonal.
_ASIDE = np.array([0.7548776662, 0.5698402910, 0.4301597090]) * 1e-6
# No more points than this are told of the polylines of a scan in a plane.
MAX_OUTLINE_POINTS = 20_000


def run(name: str, shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    held = {} if kept is None else kept
    if name == "scan_clash":
        return clash(shapes, args, held)
    if name == "scan_deviation":
        return deviation(shapes, args, held)
    return outline(shapes, args, held)


# Inside or outside


def _grid(vertices: np.ndarray, triangles: np.ndarray, axis: int) -> dict[str, Any]:
    """The triangles of a mesh by the cells of a 2D grid across ``axis`` that each one's box touches."""
    u, v = [(1, 2), (2, 0), (0, 1)][axis]
    corners = vertices[triangles]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    det = (b[:, u] - a[:, u]) * (c[:, v] - a[:, v]) - (b[:, v] - a[:, v]) * (c[:, u] - a[:, u])
    # A triangle edge-on to the rays is crossed by none.
    seen = np.abs(det) > 1e-12
    a, b, c, det = a[seen], b[seen], c[seen], det[seen]
    low = np.minimum(np.minimum(a[:, [u, v]], b[:, [u, v]]), c[:, [u, v]])
    high = np.maximum(np.maximum(a[:, [u, v]], b[:, [u, v]]), c[:, [u, v]])
    origin = low.min(axis=0) if len(a) else np.zeros(2)
    extent = np.maximum(high.max(axis=0) - origin, 1e-9) if len(a) else np.ones(2)
    # About ten cells a triangle, and no more than four million pairs of a cell and a triangle.
    n = int(np.clip(np.sqrt(max(len(a), 1) * 10), 1, 1024))
    while True:
        cell = extent / n
        first = np.clip(((low - origin) / cell).astype(np.int64), 0, n - 1)
        last = np.clip(((high - origin) / cell).astype(np.int64), 0, n - 1)
        span = last - first + 1
        count = span[:, 0] * span[:, 1]
        if count.sum() <= 4_000_000 or n <= 8:
            break
        n //= 2
    owner = np.repeat(np.arange(len(a)), count)
    k = np.arange(len(owner)) - np.repeat(np.cumsum(count) - count, count)
    wide = np.repeat(span[:, 1], count)
    cells = (np.repeat(first[:, 0], count) + k // wide) * n + np.repeat(first[:, 1], count) + k % wide
    order = np.argsort(cells, kind="stable")
    start = np.searchsorted(cells[order], np.arange(n * n + 1))
    return {"axis": axis, "a": a, "b": b, "c": c, "det": det, "origin": origin, "extent": extent, "cell": cell, "n": n, "owner": owner[order], "start": start}


def _crossings(points: np.ndarray, grid: dict[str, Any], chunk: int = 1_500_000) -> tuple[np.ndarray, np.ndarray]:
    """For each point: how many triangles a ray from it along +axis crosses, and whether it grazes an edge of one."""
    axis, n = grid["axis"], grid["n"]
    u, v = [(1, 2), (2, 0), (0, 1)][axis]
    flat = points[:, [u, v]]
    over = ((flat >= grid["origin"]) & (flat <= grid["origin"] + grid["extent"])).all(axis=1)
    at = np.clip(((flat - grid["origin"]) / grid["cell"]).astype(np.int64), 0, n - 1)
    cell = at[:, 0] * n + at[:, 1]
    per = np.where(over, grid["start"][cell + 1] - grid["start"][cell], 0)
    crossed = np.zeros(len(points), dtype=np.int64)
    grazed = np.zeros(len(points), dtype=bool)
    ends = np.cumsum(per)
    first = 0
    while first < len(points):
        # As many points at a time as have about `chunk` triangles to look at between them.
        last = max(int(np.searchsorted(ends, (ends[first - 1] if first else 0) + chunk, side="right")), first + 1)
        count = per[first:last]
        if count.sum():
            point = np.repeat(np.arange(first, last), count)
            k = np.arange(len(point)) - np.repeat(np.cumsum(count) - count, count)
            triangle = grid["owner"][np.repeat(grid["start"][cell[first:last]], count) + k]
            a, b, c = grid["a"][triangle], grid["b"][triangle], grid["c"][triangle]
            pu, pv = points[point, u] - a[:, u], points[point, v] - a[:, v]
            det = grid["det"][triangle]
            s = (pu * (c[:, v] - a[:, v]) - pv * (c[:, u] - a[:, u])) / det
            t = ((b[:, u] - a[:, u]) * pv - (b[:, v] - a[:, v]) * pu) / det
            r = 1 - s - t
            above = a[:, axis] + s * (b[:, axis] - a[:, axis]) + t * (c[:, axis] - a[:, axis]) > points[point, axis]
            hit = (s >= 0) & (t >= 0) & (r >= 0) & above
            edge = (np.minimum(np.minimum(np.abs(s), np.abs(t)), np.abs(r)) < GRAZE) & (s > -GRAZE) & (t > -GRAZE) & (r > -GRAZE) & above
            crossed += np.bincount(point[hit], minlength=len(points))
            grazed |= np.bincount(point[edge], minlength=len(points)) > 0
        first = last
    return crossed, grazed


def inside(points: np.ndarray, vertices: np.ndarray, triangles: np.ndarray, grids: dict[int, Any] | None = None) -> np.ndarray:
    """Whether each point is inside a closed mesh: a ray from it along +Z crosses the mesh an odd number of times.

    A point whose ray passes through an edge of a triangle, where a crossing
    may be counted twice or not at all, is asked again from a millionth of a
    millimetre aside, then along +X, then along +Y, each from a little further
    aside: a point that near the surface may be said to be on either side of
    it. ``grids`` keeps what was worked out of the mesh from one call to the
    next. A mesh that is not closed has no inside, and what this says of it
    means nothing.
    """
    points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    vertices = np.asarray(vertices, dtype=np.float64)
    triangles = np.asarray(triangles, dtype=np.int64)
    grids = {} if grids is None else grids
    answer = np.zeros(len(points), dtype=bool)
    asked = np.arange(len(points))
    for attempt, axis in enumerate((2, 2, 0, 1)):
        if len(asked) == 0:
            break
        if axis not in grids:
            grids[axis] = _grid(vertices, triangles, axis)
        crossed, grazed = _crossings(points[asked] + attempt * _ASIDE, grids[axis])
        answer[asked] = (crossed & 1) == 1
        asked = asked[grazed]
    return answer


def clusters(points: np.ndarray, cell: float = CELL) -> np.ndarray:
    """A number for each point, the same for points whose cells of ``cell`` mm touch (by a face, an edge or a corner).

    The clusters are numbered from 0 by size, the largest first.
    """
    points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if len(points) == 0:
        return np.zeros(0, dtype=np.int64)
    cells = np.floor(points / cell).astype(np.int64)
    cells -= cells.min(axis=0)
    span = cells.max(axis=0) + 3
    key = ((cells[:, 0] + 1) * span[1] + cells[:, 1] + 1) * span[2] + cells[:, 2] + 1
    filled, of = np.unique(key, return_inverse=True)
    of = of.reshape(-1)
    pairs = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                beside = filled + (dx * span[1] + dy) * span[2] + dz
                at = np.minimum(np.searchsorted(filled, beside), len(filled) - 1)
                there = filled[at] == beside
                pairs.append(np.stack([np.flatnonzero(there), at[there]], axis=1))
    pairs = np.concatenate(pairs)
    label = np.arange(len(filled))
    while True:
        # Every filled cell takes the least label among itself and its neighbours, until none changes.
        least = label.copy()
        np.minimum.at(least, pairs[:, 0], label[pairs[:, 1]])
        least = least[least]
        if np.array_equal(least, label):
            break
        label = least
    _, numbered, sizes = np.unique(label, return_inverse=True, return_counts=True)
    points_in = np.bincount(numbered[of], minlength=len(sizes))
    by_size = np.argsort(-points_in, kind="stable")
    rank = np.empty(len(by_size), dtype=np.int64)
    rank[by_size] = np.arange(len(by_size))
    return rank[numbered[of]]


# Distances


def sampled(vertices: np.ndarray, triangles: np.ndarray, spacing: float = SURFACE) -> tuple[np.ndarray, np.ndarray]:
    """Points on a mesh no further apart than about ``spacing``, and the triangle each is on.

    Each triangle gets a grid along two of its sides, as fine as each side
    needs, so a long thin triangle is not sampled as a large one would be.
    """
    corners = np.asarray(vertices, dtype=np.float64)[np.asarray(triangles, dtype=np.int64)]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    nu = np.clip(np.ceil(np.linalg.norm(b - a, axis=1) / spacing).astype(np.int64), 1, 512)
    nv = np.clip(np.ceil(np.linalg.norm(c - a, axis=1) / spacing).astype(np.int64), 1, 512)
    count = (nu + 1) * (nv + 1)
    owner = np.repeat(np.arange(len(a)), count)
    k = np.arange(len(owner)) - np.repeat(np.cumsum(count) - count, count)
    wide = np.repeat(nv + 1, count)
    s = (k // wide) / np.repeat(nu, count)
    t = (k % wide) / np.repeat(nv, count)
    on = s + t <= 1 + 1e-9
    owner, s, t = owner[on], s[on], t[on]
    return a[owner] * (1 - s - t)[:, None] + b[owner] * s[:, None] + c[owner] * t[:, None], owner


def to_triangles(p: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """How far each point ``p[i]`` is from the triangle ``a[i] b[i] c[i]``, and the point of the triangle nearest to it."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(axis=1), (ac * ap).sum(axis=1)
    bp = p - b
    d3, d4 = (ab * bp).sum(axis=1), (ac * bp).sum(axis=1)
    cp = p - c
    d5, d6 = (ab * cp).sum(axis=1), (ac * cp).sum(axis=1)
    va, vb, vc = d3 * d6 - d5 * d4, d5 * d2 - d1 * d6, d1 * d4 - d3 * d2
    with np.errstate(divide="ignore", invalid="ignore"):
        whole = va + vb + vc
        # Over the face, unless one of the cases below says an edge or a corner is nearer.
        near = a + ab * (vb / whole)[:, None] + ac * (vc / whole)[:, None]
        near = np.where(((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0))[:, None], b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)))[:, None], near)
        near = np.where(((vb <= 0) & (d2 >= 0) & (d6 <= 0))[:, None], a + ac * (d2 / (d2 - d6))[:, None], near)
        near = np.where(((vc <= 0) & (d1 >= 0) & (d3 <= 0))[:, None], a + ab * (d1 / (d1 - d3))[:, None], near)
    near = np.where(((d6 >= 0) & (d5 <= d6))[:, None], c, near)
    near = np.where(((d3 >= 0) & (d4 <= d3))[:, None], b, near)
    near = np.where(((d1 <= 0) & (d2 <= 0))[:, None], a, near)
    # A triangle with no area is its first corner.
    near = np.where(np.isfinite(near), near, a)
    return np.linalg.norm(p - near, axis=1), near


def _tree(points: np.ndarray) -> Any:
    """A KD-tree over points. scipy comes with build123d; the worker loads it when a scan is first asked about."""
    try:
        from scipy.spatial import cKDTree
    except ImportError as e:
        raise QueryError("bad_request", "checks against a scan need scipy, which build123d brings: it is not in this workspace's environment") from e
    # Not scipy's defaults: on points that lie in sheets they make a tree that takes seconds to ask (E2).
    return cKDTree(points, balanced_tree=False, compact_nodes=False)


# What is asked


def _number(value: Any, default: float, least: float, most: float, name: str) -> float:
    if value is None:
        return default
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not least <= value <= most:
        raise QueryError("bad_request", f"{name} is a number from {least:g} to {most:g}")
    return float(value)


def _part(shapes: dict[str, Any], args: dict[str, Any]) -> tuple[str, str, Any, str]:
    layout, part = args.get("layout"), args.get("part")
    if not isinstance(layout, str) or not isinstance(part, str):
        raise QueryError("bad_request", "a scan query needs args.layout and args.part, the name of a part of it, both strings")
    return layout, part, need_part(shapes, layout, part), f"{layout}:{part}"


class _Scan:
    """A scan where its transform puts it: the points in the object frame, the triangles, and which vertices count."""

    def __init__(self, said: Any) -> None:
        if not isinstance(said, dict) or not isinstance(said.get("path"), str) or not isinstance(said.get("id"), str):
            raise QueryError("bad_request", "a scan query needs args.scan, with id and path, both strings, and transform")
        self.id = said["id"]
        try:
            vertices, self.triangles, _ = scanfile.read_bin(said["path"])
        except (OSError, ValueError) as e:
            raise QueryError("bad_request", f"the mesh of {self.id} could not be read: {e}") from e
        transform = said.get("transform")
        t, q, s = (transform or {}).get("t"), (transform or {}).get("q"), (transform or {}).get("s", 1)
        numbers = [*(t if isinstance(t, list) else []), *(q if isinstance(q, list) else []), s]
        fine = len(numbers) == 8 and all(isinstance(n, (int, float)) and not isinstance(n, bool) and np.isfinite(n) for n in numbers)
        if not fine or not s > 0 or not any(q):
            raise QueryError("bad_request", f"the transform of {self.id} is not one: t is three numbers, q four that are not all zero, s more than zero")
        turn = tess._rotation([float(c) / float(np.linalg.norm(q)) for c in q])
        self.points = vertices.astype(np.float64) @ turn.T * float(s) + np.array(t, dtype=np.float64)
        self.counts = np.ones(len(vertices), dtype=bool)
        only, ignore = said.get("only"), said.get("ignore") or []
        try:
            if only is not None:
                self.counts = self._of(scanfile.read_mask(only, len(self.triangles)))
            for path in ignore:
                self.counts &= ~self._of(scanfile.read_mask(path, len(self.triangles)))
        except (OSError, ValueError, TypeError) as e:
            raise QueryError("bad_request", f"a region of {self.id} could not be read: {e}") from e

    def _of(self, mask: np.ndarray) -> np.ndarray:
        """The vertices of the triangles a region has."""
        vertices = np.zeros(len(self.points), dtype=bool)
        vertices[self.triangles[mask].reshape(-1)] = True
        return vertices


def _scan(args: dict[str, Any], kept: dict[Any, Any]) -> _Scan:
    """The scan a query names, read once for as long as its file and what is asked of it are the same."""
    said = args.get("scan")
    try:
        stat = os.stat(said["path"])
        which = (said["path"], stat.st_mtime_ns, stat.st_size, repr(said.get("transform")), repr(said.get("only")), repr(said.get("ignore")))
    except (TypeError, KeyError, OSError):
        which = None
    if which is None or kept.get("scan", (None, None))[0] != which:
        # One scan at a time is kept: Micra's points and triangles are 40 MB.
        kept["scan"] = (which, _Scan(said))
    return kept["scan"][1]


def _mesh(shape: Any, key: str, kept: dict[Any, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The mesh a part is drawn with, and how many of its triangles each face has: worked out once."""
    if ("scan mesh", key) not in kept:
        kept["scan mesh", key] = tess.mesh_faces(shape)
    return kept["scan mesh", key]


def _surface_tree(vertices: np.ndarray, triangles: np.ndarray, key: str, kept: dict[Any, Any]) -> tuple[Any, np.ndarray, np.ndarray]:
    """A tree over the part's mesh sampled every millimetre, the samples, and the triangle each is on."""
    if ("scan surface", key) not in kept:
        points, owner = sampled(vertices, triangles)
        kept["scan surface", key] = (_tree(points), points, owner)
    return kept["scan surface", key]


def _brep(shape: Any, part: str, key: str, kept: dict[Any, Any]) -> _Surface:
    """What ``nearest`` keeps of a part, kept where it keeps it."""
    if key not in kept:
        kept[key] = _Surface(shape)
    return kept[key]


def _xyz(point: Any) -> list[float]:
    return [float(c) + 0.0 for c in point]


def _box(points: np.ndarray) -> dict[str, list[float]]:
    return {"min": _xyz(points.min(axis=0)), "max": _xyz(points.max(axis=0))}


def _face_of(per_face: np.ndarray, triangle: int) -> int:
    """The face a triangle of the part's mesh belongs to."""
    return int(np.searchsorted(np.cumsum(per_face), triangle, side="right"))


# scan_clash


def clash(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    started = time.monotonic()
    layout, part, shape, key = _part(shapes, args)
    if not topo.solids(shape):
        raise QueryError("bad_request", f"{part} is not a solid: nothing is inside it; scan_deviation says how far it is from the scan")
    margin = _number(args.get("margin"), 5.0, 0.0, 50.0, "margin")
    scan = _scan(args, kept)
    vertices, triangles, _ = _mesh(shape, key, kept)
    low, high = vertices.min(axis=0) - margin, vertices.max(axis=0) + margin
    near = np.flatnonzero(((scan.points >= low) & (scan.points <= high)).all(axis=1))
    ignored = int((~scan.counts[near]).sum())
    near = near[scan.counts[near]]
    every = max(1, -(-len(near) // MAX_CANDIDATES))
    checked = near[::every]
    grids = kept.setdefault(("scan grids", key), {})
    within = np.zeros(len(checked), dtype=bool)
    done = 0
    while done < len(checked) and time.monotonic() - started <= BUDGET:
        within[done : done + BATCH] = inside(scan.points[checked[done : done + BATCH]], vertices, triangles, grids)
        done = min(done + BATCH, len(checked))
    partial = done < len(checked)
    checked, within = checked[:done], within[:done]
    points = scan.points[checked]
    tree, _, _ = _surface_tree(vertices, triangles, key, kept)
    distance = tree.query(points)[0] if len(points) else np.zeros(0)
    surface = _brep(shape, part, key, kept)
    retaken = 0

    def taken_again(candidates: np.ndarray, deepest: bool) -> dict[str, Any] | None:
        """Of a few scan points, the one deepest in the part or nearest to it by the B-rep, with what it is under."""
        nonlocal retaken
        best = None
        for n in candidates:
            if retaken >= MAX_RETAKEN:
                break
            retaken += 1
            try:
                found = surface.nearest(part, key, _xyz(points[n]))
            except QueryError:
                continue
            if best is None or (found["distance"] > best[1]["distance"]) == deepest:
                best = (n, found)
        return None if best is None else {"at": _xyz(points[best[0]]), "on": best[1]["point"], "face": best[1]["ref"], "distance": best[1]["distance"]}

    inner = np.flatnonzero(within)
    label = clusters(points[inner])
    count = int(label.max()) + 1 if len(inner) else 0
    told = []
    for number in range(min(count, MAX_CLUSTERS)):
        members = inner[label == number]
        deep = taken_again(members[np.argsort(-distance[members])[:2]], True)
        told.append(
            {
                "count": len(members),
                "centre": _xyz(points[members].mean(axis=0)),
                "bbox": _box(points[members]),
                **({} if deep is None else {"depth": deep["distance"], "at": deep["at"], "under": deep["face"]}),
            }
        )
    deepest = taken_again(inner[np.argsort(-distance[inner])[:3]], True)
    for one in told:
        if "depth" in one and (deepest is None or one["depth"] > deepest["distance"]):
            deepest = {"distance": one["depth"], "at": one["at"], "face": one["under"]}
    outer = np.flatnonzero(~within)
    nearest = taken_again(outer[np.argsort(distance[outer])[:3]], False)
    # Triangles of the scan with a corner inside the part and a corner outside it go through its surface.
    place = np.full(len(scan.points), -1, dtype=np.int64)
    place[checked] = np.arange(len(checked))
    corners = place[scan.triangles[(place[scan.triangles[:, 0]] >= 0)]]
    corners = corners[(corners >= 0).all(axis=1)]
    sides = within[corners]
    crossing = int((sides.any(axis=1) & ~sides.all(axis=1)).sum()) if len(corners) else 0
    return {
        "part": part,
        "scan": scan.id,
        "points": {"scan": len(scan.points), "candidates": len(near), "checked": len(checked), "ignored": ignored},
        "inside": {"count": len(inner), "crossing": crossing, "clusters": told, "clustersOmitted": max(0, count - MAX_CLUSTERS)},
        "deepest": None if deepest is None else {"depth": deepest["distance"], "at": deepest["at"], "under": deepest["face"]},
        "nearest": None if nearest is None else {"distance": nearest["distance"], "at": nearest["at"], "on": nearest["on"], "face": nearest["face"]},
        "sampling": {
            "every": every,
            "cell": CELL,
            "surface": SURFACE,
            "deflection": kept.get(("deflection", key), tess.DEVIATION),
            "retaken": retaken,
            "partial": partial,
            "seconds": round(time.monotonic() - started, 2),
        },
        "how": "scan vertices inside the part, by ray parity on the mesh the part is drawn with; each depth and distance told is from that scan point to the part's B-rep",
        "exact": False,
    }


# scan_deviation


def _stats(distance: np.ndarray) -> dict[str, float]:
    p50, p90, p95 = (float(x) for x in np.percentile(distance, [50, 90, 95]))
    return {
        "min": float(distance.min()),
        "mean": float(distance.mean()),
        "max": float(distance.max()),
        "rms": float(np.sqrt((distance**2).mean())),
        "p50": p50,
        "p90": p90,
        "p95": p95,
    }


def _to_scan(samples: np.ndarray, scan: _Scan, within: float) -> tuple[np.ndarray, np.ndarray]:
    """How far each sample is from the scan's surface, and the point of it that is nearest: infinity where nothing is within ``within``."""
    low, high = samples.min(axis=0) - within, samples.max(axis=0) + within
    near = np.flatnonzero(scan.counts & ((scan.points >= low) & (scan.points <= high)).all(axis=1))
    far = np.full(len(samples), np.inf)
    if len(near) == 0:
        return far, samples.copy()
    points = scan.points[near]
    place = np.full(len(scan.points), -1, dtype=np.int64)
    place[near] = np.arange(len(near))
    corners = place[scan.triangles]
    corners = corners[(corners >= 0).all(axis=1)]
    # For each scan vertex, the triangles it is a corner of.
    order = np.argsort(corners.reshape(-1), kind="stable")
    of = order // 3
    start = np.searchsorted(corners.reshape(-1)[order], np.arange(len(near) + 1))
    apart, beside = _tree(points).query(samples, k=min(4, len(near)))
    apart, beside = apart.reshape(len(samples), -1), beside.reshape(len(samples), -1)
    best, at = apart[:, 0].copy(), points[beside[:, 0]].copy()
    for column in range(beside.shape[1]):
        vertex = beside[:, column]
        count = start[vertex + 1] - start[vertex]
        sample = np.repeat(np.arange(len(samples)), count)
        k = np.arange(len(sample)) - np.repeat(np.cumsum(count) - count, count)
        triangle = corners[of[np.repeat(start[vertex], count) + k]]
        distance, nearest = to_triangles(samples[sample], points[triangle[:, 0]], points[triangle[:, 1]], points[triangle[:, 2]])
        # The nearest triangle of each sample: the smallest distance first, and the first of each sample taken.
        ranked = np.lexsort((distance, sample))
        first = ranked[np.unique(sample[ranked], return_index=True)[1]]
        better = distance[first] < best[sample[first]]
        best[sample[first][better]] = distance[first][better]
        at[sample[first][better]] = nearest[first][better]
    best[best > within] = np.inf
    return best, at


def deviation(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    started = time.monotonic()
    layout, part, shape, key = _part(shapes, args)
    source = args.get("from", "part")
    if source not in ("part", "scan"):
        raise QueryError("bad_request", "from is part (points of the part, to the scan) or scan (points of the scan, to the part)")
    within = _number(args.get("within"), 50.0, 0.1, 1000.0, "within")
    wanted = int(_number(args.get("samples"), 20_000, 100, 100_000, "samples"))
    scan = _scan(args, kept)
    vertices, triangles, per_face = _mesh(shape, key, kept)
    faces = args.get("faces")
    chosen = np.ones(len(triangles), dtype=bool)
    if faces is not None:
        if not isinstance(faces, list) or not faces or not all(isinstance(f, int) and not isinstance(f, bool) and 0 <= f < len(per_face) for f in faces):
            raise QueryError("bad_ref", f"faces are numbers of faces of {part}, which has {len(per_face)}: F0 to F{len(per_face) - 1}")
        ends = np.cumsum(per_face)
        chosen[:] = False
        for face in faces:
            chosen[ends[face] - per_face[face] : ends[face]] = True
    solid = bool(topo.solids(shape))
    grids = kept.setdefault(("scan grids", key), {})
    surface = _brep(shape, part, key, kept)
    numbers = np.flatnonzero(chosen)
    if source == "part":
        points, owner = sampled(vertices, triangles[chosen])
        some = np.unique(np.linspace(0, len(points) - 1, min(wanted, len(points))).astype(np.int64))
        points, owner = points[some], numbers[owner[some]]
        distance, other = _to_scan(points, scan, within)
        how = f"from {len(points):,} points of the part's mesh to the scan's triangles"
    else:
        if faces is None:
            tree, _, on_triangle = _surface_tree(vertices, triangles, key, kept)
        else:
            on_points, on_triangle = sampled(vertices, triangles[chosen])
            tree, on_triangle = _tree(on_points), numbers[on_triangle]
        low, high = vertices[triangles[chosen]].reshape(-1, 3).min(axis=0) - within, vertices[triangles[chosen]].reshape(-1, 3).max(axis=0) + within
        near = np.flatnonzero(scan.counts & ((scan.points >= low) & (scan.points <= high)).all(axis=1))
        near = near[np.unique(np.linspace(0, len(near) - 1, min(wanted, len(near))).astype(np.int64))] if len(near) else near
        points = other = scan.points[near]
        distance, sample = tree.query(points, distance_upper_bound=within) if len(points) else (np.zeros(0), np.zeros(0, dtype=np.int64))
        owner = on_triangle[np.minimum(sample, len(on_triangle) - 1)]
        how = f"from {len(points):,} vertices of the scan to the part's mesh sampled every {SURFACE:g} mm"
    compared = np.isfinite(distance)
    said: dict[str, Any] = {"part": part, "faces": faces, "scan": scan.id, "from": source, "samples": len(points), "compared": int(compared.sum()), "beyond": int((~compared).sum())}
    if not compared.any():
        return {**said, "distance": None, "signed": None, "worst": None, "sampling": _sampling(key, kept, started), "how": f"{how}; nothing of the scan is within {within:g} mm", "exact": False}
    signed = None
    if solid:
        # The side is the scan's: where the scan's own point is inside the part, the distance counts as negative.
        scan_inside = inside(other[compared], vertices, triangles, grids)
        signs = np.where(scan_inside, -1.0, 1.0) * distance[compared]
        signed = {"min": float(signs.min()), "mean": float(signs.mean()), "max": float(signs.max()), "inside": int(scan_inside.sum())}
    worst = int(np.flatnonzero(compared)[np.argmax(distance[compared])])
    told = {"distance": float(distance[worst]), "at": _xyz(points[worst]), "on": _xyz(other[worst]), "face": f"{part}/F{_face_of(per_face, int(owner[worst]))}"}
    if source == "scan":
        # One point of the scan, taken again on the B-rep: that distance is the part's own.
        try:
            found = surface.nearest(part, key, _xyz(points[worst]))
            told = {"distance": found["distance"], "at": _xyz(points[worst]), "on": found["point"], "face": found["ref"]}
        except QueryError:
            pass
    return {
        **said,
        "distance": _stats(distance[compared]),
        "signed": signed,
        "worst": told,
        "sampling": _sampling(key, kept, started),
        "how": f"{how}; + where the scan is outside the part, − where it is inside" if solid else how,
        "exact": False,
    }


def _sampling(key: str, kept: dict[Any, Any], started: float) -> dict[str, Any]:
    return {"surface": SURFACE, "deflection": kept.get(("deflection", key), tess.DEVIATION), "partial": False, "seconds": round(time.monotonic() - started, 2)}


# scan_section


def outline(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    """Where a plane cuts a scan: polylines in the plane's own axes, as ``section`` gives a part's loops."""
    from .section import _Frame

    plane = args.get("plane")
    origin, normal = (plane or {}).get("origin") if isinstance(plane, dict) else None, (plane or {}).get("normal") if isinstance(plane, dict) else None
    fine = all(isinstance(v, list) and len(v) == 3 and all(isinstance(c, (int, float)) and not isinstance(c, bool) and np.isfinite(c) for c in v) for v in (origin, normal))
    if not fine or not any(normal):
        raise QueryError("bad_request", "scan_section needs args.plane, with origin and normal, three numbers each, the normal not all zeros")
    scan = _scan(args, kept)
    frame = _Frame(np.array(origin, dtype=np.float64), np.array(normal, dtype=np.float64) / np.linalg.norm(normal))
    side = (scan.points - frame.origin) @ frame.normal >= 0
    corners = scan.triangles[scan.counts[scan.triangles].all(axis=1)]
    corners = corners[side[corners].any(axis=1) & ~side[corners].all(axis=1)]
    # The corner that is alone on its side of the plane: the two edges from it go through the plane.
    alone = np.where(side[corners[:, 0]] != side[corners[:, 1]], np.where(side[corners[:, 0]] != side[corners[:, 2]], 0, 1), 2)
    rows = np.arange(len(corners))
    tip, left, right = corners[rows, alone], corners[rows, (alone + 1) % 3], corners[rows, (alone + 2) % 3]
    height = (scan.points - frame.origin) @ frame.normal

    def through(one: np.ndarray, other: np.ndarray) -> np.ndarray:
        share = (height[one] / (height[one] - height[other]))[:, None]
        return frame.flat(scan.points[one] + (scan.points[other] - scan.points[one]) * share)

    ends = np.stack([through(tip, left), through(tip, right)], axis=1)
    # Two segments meet where they cross the same edge of the scan: an edge is its two vertices, least first.
    edges = np.stack([np.minimum(tip, left) * len(scan.points) + np.maximum(tip, left), np.minimum(tip, right) * len(scan.points) + np.maximum(tip, right)], axis=1)
    at: dict[int, list[int]] = {}
    for segment, (one, other) in enumerate(edges.tolist()):
        at.setdefault(one, []).append(segment)
        at.setdefault(other, []).append(segment)
    unused = np.ones(len(edges), dtype=bool)
    lines = []
    for segment in range(len(edges)):
        if not unused[segment]:
            continue
        unused[segment] = False
        chain = [ends[segment, 0], ends[segment, 1]]
        closed = False
        for forwards in (True, False):
            edge = int(edges[segment, 1 if forwards else 0])
            while True:
                onward = [s for s in at[edge] if unused[s]]
                if not onward:
                    closed = closed or (forwards and edge == int(edges[segment, 0]))
                    break
                following = onward[0]
                unused[following] = False
                first = int(edges[following, 0]) == edge
                edge = int(edges[following, 1 if first else 0])
                point = ends[following, 1 if first else 0]
                chain.append(point) if forwards else chain.insert(0, point)
            if closed:
                break
        points = np.array(chain)
        if closed:
            points = points[:-1]
        lines.append((float(np.linalg.norm(np.diff(np.array(chain), axis=0), axis=1).sum()), closed, points))
    lines.sort(key=lambda line: -line[0])
    told, room = [], MAX_OUTLINE_POINTS
    for _, closed, points in lines:
        if len(points) > room:
            break
        room -= len(points)
        told.append({"points": [[float(u) + 0.0, float(v) + 0.0] for u, v in points], "closed": closed})
    every = np.concatenate([line[2] for line in lines[: len(told)]]) if told else None
    return {
        "scan": scan.id,
        "plane": {"origin": _xyz(frame.origin), "normal": _xyz(frame.normal), "x": _xyz(frame.x), "y": _xyz(frame.y)},
        "polylines": told,
        "omitted": len(lines) - len(told),
        "segments": len(edges),
        "bounds": None if every is None else {"min": [float(c) for c in every.min(axis=0)], "max": [float(c) for c in every.max(axis=0)]},
        "exact": False,
    }
