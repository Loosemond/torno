"""What a part is to a scan: the ``scan_clash``, ``scan_deviation`` and ``scan_section`` queries.

A scan is a mesh someone measured: nothing here is exact, and every answer
says so. Which scan points are inside a part is decided on the mesh the part
is drawn with, by counting how often a ray from the point crosses it; which
of the scan's triangles go through the part, by meeting their edges with that
mesh; how far a point is from a mesh, from the triangles of that mesh that
are nearest to it; and, for the few points an answer names, the distance is
taken again from the B-rep. The scan is read from the ``mesh.bin`` the query
names: the worker is given paths, and never looks for a file itself.
"""

import math
import os
import time
from typing import Any

import numpy as np

from . import scanfile, tess, topo
from .queries import FARTHEST, QueryError, _is_coordinate, _Surface, need_layout, need_part

# No more scan vertices than this are tested against a part, and no more scan triangles: more are thinned to
# every n-th, and the answer says so.
MAX_CANDIDATES = 200_000
# No more points than this are taken again on the B-rep (16 ms each on a part of 2,600 faces).
MAX_RETAKEN = 32
MAX_CLUSTERS = 8
# Scan points inside a part are one cluster when their cells of this size, mm, touch.
CELL = 5.0
# How far apart, mm, the points are that stand for a mesh when the triangles nearest to a point are looked for.
SURFACE = 1.0
# Seconds a query gives itself, of the 30 the supervisor allows: what is left undone is said. The scan's vertices
# are tested until the first share of it is spent and its triangles until the second; the rest is for the B-rep.
BUDGET = 15.0
POINTS_SHARE = 0.6
EDGES_SHARE = 0.8
BATCH = 50_000
# The scan's triangles are tried this many at a time, and the clock looked at between: where every edge is at the
# part's surface, as many take seconds.
EDGE_BATCH = 5_000
# A ray this near, in barycentric terms, to a triangle's edge is asked again along another axis.
GRAZE = 1e-9
# How far aside, mm, a point is asked from again when its ray grazed an edge: along no axis and no diagonal.
_ASIDE = np.array([0.7548776662, 0.5698402910, 0.4301597090]) * 1e-6
# A point this near a mesh, mm, is on it: it touches, and is neither inside nor outside.
TOUCH = 1e-6
# A point is measured to the triangles that this many of the nearest points standing for a mesh are on: to the
# first many, and to the next where that did not settle it.
NEAREST = (8, 32, 128)
# More than the first of those only for a point no further from the mesh than this, mm: of one further, too many
# of them are as near for that to settle it, and less hangs on it.
NEAR = 10.0
# No more points than this stand for a part's mesh, or for a scan's: above it they are further apart, and the answer says how far.
MAX_PART_SAMPLES = 8_000_000
MAX_SCAN_SAMPLES = 2_000_000
# A scan's edge is met with a part's mesh in pieces this many times as long as the points that stand for the mesh are apart.
PIECE = 4.0
# No more points than this are told of the polylines of a scan in a plane.
MAX_OUTLINE_POINTS = 4_000
# Ends of segments this near each other, mm, are one point of a polyline.
WELD = 1e-4


def run(name: str, shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    held = {} if kept is None else kept
    if name == "scan_clash":
        return clash(shapes, args, held)
    if name == "scan_deviation":
        return deviation(shapes, args, held)
    return outline(shapes, args, held)


def _expand(count: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For the counts ``[2, 0, 3]``: whose each of the five is, ``[0, 0, 2, 2, 2]``, and which of its own, ``[0, 1, 0, 1, 2]``."""
    owner = np.repeat(np.arange(len(count)), count)
    return owner, np.arange(len(owner)) - np.repeat(np.cumsum(count) - count, count)


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


def _sides(corners: np.ndarray) -> np.ndarray:
    """The three sides of each triangle, mm: from its first corner to its second, from the first to the third, and the other."""
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    return np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - a, axis=1), np.linalg.norm(c - b, axis=1)], axis=1)


def _steps(sides: np.ndarray, spacing: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """How many steps of at most ``spacing`` the first two sides of each triangle are sampled in, and which triangles have no side longer than it."""
    nu = np.clip(np.ceil(sides[:, 0] / spacing).astype(np.int64), 1, 512)
    nv = np.clip(np.ceil(sides[:, 1] / spacing).astype(np.int64), 1, 512)
    return nu, nv, sides.max(axis=1) <= spacing


def sampled(vertices: np.ndarray, triangles: np.ndarray, spacing: float = SURFACE) -> tuple[np.ndarray, np.ndarray]:
    """Points on a mesh no further apart than about ``spacing``, and the triangle each is on.

    Each triangle gets a grid along two of its sides, as fine as each side
    needs, so a long thin triangle is not sampled as a large one would be. A
    triangle with no side longer than the spacing gets its middle alone: no
    point of it is further from that than two thirds of the spacing.
    """
    corners = np.asarray(vertices, dtype=np.float64)[np.asarray(triangles, dtype=np.int64)]
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    nu, nv, small = _steps(_sides(corners), spacing)
    count = np.where(small, 1, (nu + 1) * (nv + 1))
    owner = np.repeat(np.arange(len(a)), count)
    k = np.arange(len(owner)) - np.repeat(np.cumsum(count) - count, count)
    wide = np.repeat(nv + 1, count)
    alone = small[owner]
    s = np.where(alone, 1 / 3, (k // wide) / np.repeat(nu, count))
    t = np.where(alone, 1 / 3, (k % wide) / np.repeat(nv, count))
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


def _spacing(corners: np.ndarray, spacing: float, most: int) -> tuple[float, float]:
    """How far apart to ask ``sampled`` for its points so that they are at most ``most``, and how far apart they then really are.

    The two differ for a triangle with a side of more than 512 times the
    spacing: ``sampled`` gives no side more points than that. The spacing
    grows by half until the points are few enough, and no further than the
    longest side there is: by then every triangle has one point.
    """
    if len(corners) == 0:
        return spacing, spacing
    sides = _sides(corners)
    while spacing < sides.max():
        nu, nv, small = _steps(sides, spacing)
        if np.where(small, 1, (nu + 1) * (nv + 2) // 2).sum() <= most:
            break
        spacing *= 1.5
    # The two sides the points are laid along are the first two.
    return spacing, max(spacing, float(sides[:, :2].max()) / 512)


class _Sampled:
    """A mesh, with points that stand for it in a tree: what says how far a point is from the mesh.

    The points only find the triangles: the distance is to the triangles
    themselves. It is the true one once every point that stands for the mesh
    and is nearer than the distance found and ``reach`` has had its triangle
    tried: the triangle that is nearest has a point no further than that.
    ``spacing`` is how far apart the points are, mm.
    """

    def __init__(self, vertices: np.ndarray, triangles: np.ndarray, most: int = MAX_PART_SAMPLES) -> None:
        self.corners = np.asarray(vertices, dtype=np.float64)[np.asarray(triangles, dtype=np.int64).reshape(-1, 3)]
        asked, self.spacing = _spacing(self.corners, SURFACE, most)
        self.points, self.owner = sampled(vertices, triangles, asked) if len(self.corners) else (np.zeros((0, 3)), np.zeros(0, dtype=np.int64))
        self.tree = _tree(self.points) if len(self.points) else None
        # No point of a triangle is further than this from one of those that stand for it.
        self.reach = 1.1 * self.spacing

    def nearest(self, points: np.ndarray, within: float = math.inf, sure: float = math.inf) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """For each point: how far it is from the mesh, the point of the mesh nearest to it, and the triangle that is on.

        Infinity, the point itself and -1 where nothing of the mesh is within
        ``within``. The triangles of the ``NEAREST[0]`` nearest points are
        tried first, and of more, up to ``NEAREST[-1]``, for a point whose
        distance is not yet known to be the true one and is no more than
        ``sure`` nor than ``NEAR``. A distance that is still not known to be
        true is of a triangle all the same, and too long by less than
        ``reach``: by far less where the triangles are small, since those of
        the nearest points are then all round the nearest one.
        """
        points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
        best, at, on = np.full(len(points), np.inf), points.copy(), np.full(len(points), -1, dtype=np.int64)
        if self.tree is None or len(points) == 0:
            return best, at, on
        asked, tried = np.arange(len(points)), 0
        for most in NEAREST:
            most = min(most, len(self.points))
            # A triangle within reach has a point standing for it no further than that and the reach.
            apart, sample = self.tree.query(points[asked], k=most, distance_upper_bound=within + self.reach)
            apart, sample = apart.reshape(len(asked), -1), sample.reshape(len(asked), -1)
            for column in range(tried, most):
                rows = np.flatnonzero(sample[:, column] < len(self.points))
                triangle = self.owner[sample[rows, column]]
                corners = self.corners[triangle]
                distance, nearest = to_triangles(points[asked[rows]], corners[:, 0], corners[:, 1], corners[:, 2])
                better = distance < best[asked[rows]]
                rows, distance, nearest, triangle = asked[rows[better]], distance[better], nearest[better], triangle[better]
                best[rows], at[rows], on[rows] = distance, nearest, triangle
            # Not yet sure: a point further than the furthest tried may still stand for a nearer triangle.
            unsure = (apart[:, -1] < best[asked] + self.reach) & (best[asked] <= min(sure, NEAR))
            asked, tried = asked[unsure], most
            if len(asked) == 0 or most == len(self.points):
                break
        beyond = best > within
        best[beyond], at[beyond], on[beyond] = np.inf, points[beyond], -1
        return best, at, on


# Edges through a mesh


def _clipped(p: np.ndarray, d: np.ndarray, low: np.ndarray, high: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The part of each segment ``p`` to ``p + d`` that is in a box, as two shares of it: none where the first is above the second."""
    still = d == 0
    with np.errstate(divide="ignore", invalid="ignore"):
        one, other = (low - p) / d, (high - p) / d
    between = (p >= low) & (p <= high)
    enters = np.where(still, np.where(between, -np.inf, np.inf), np.minimum(one, other))
    leaves = np.where(still, np.where(between, np.inf, -np.inf), np.maximum(one, other))
    return np.maximum(enters.max(axis=1), 0.0), np.minimum(leaves.min(axis=1), 1.0)


def _hits(p: np.ndarray, d: np.ndarray, first: np.ndarray, last: np.ndarray, surface: "_Sampled") -> tuple[np.ndarray, np.ndarray]:
    """Where segments meet the triangles of a mesh: the segment and the share of it, 0 to 1, of each meeting.

    Each segment is looked at between its shares ``first`` and ``last``, in
    pieces of ``PIECE`` times the spacing of the points that stand for the
    mesh. A triangle a piece meets has one of those points within half the
    piece and the spacing of the piece's middle: the two trees say which
    pieces and points are that near, and only those pairs of a segment and a
    triangle are tried. A meeting on the edge two triangles share is found
    twice: whoever asks counts the places, not the meetings. A segment that
    lies in the plane of a triangle does not meet it.
    """
    nothing = np.zeros(0, dtype=np.int64), np.zeros(0)
    if surface.tree is None or len(p) == 0:
        return nothing
    long = PIECE * surface.spacing
    pieces = np.clip(np.ceil(np.linalg.norm(d, axis=1) * (last - first) / long), 1, 4096).astype(np.int64)
    segment, k = _expand(pieces)
    width = (last - first)[segment] / pieces[segment]
    middle = p[segment] + d[segment] * (first[segment] + (k + 0.5) * width)[:, None]
    # A piece of a segment longer than 4096 pieces is longer than the others: so then is how far is looked from its middle.
    reach = float((np.linalg.norm(d[segment], axis=1) * width).max()) / 2 + surface.reach
    found_segment, found_share = [], []
    for start in range(0, len(segment), BATCH):
        near = _tree(middle[start : start + BATCH]).sparse_distance_matrix(surface.tree, reach, output_type="ndarray")
        pair = np.unique(segment[start + near["i"]] * len(surface.corners) + surface.owner[near["j"]])
        asked, triangle = pair // len(surface.corners), pair % len(surface.corners)
        a, e1, e2 = surface.corners[triangle, 0], surface.corners[triangle, 1] - surface.corners[triangle, 0], surface.corners[triangle, 2] - surface.corners[triangle, 0]
        along, from_a = d[asked], p[asked] - a
        h = np.cross(along, e2)
        det = (e1 * h).sum(axis=1)
        # Edge-on to the triangle within a millionth of a millionth of a turn: it runs along it, and meets it nowhere.
        across = np.abs(det) > 1e-12 * np.linalg.norm(along, axis=1) * np.linalg.norm(e1, axis=1) * np.linalg.norm(e2, axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            s = (from_a * h).sum(axis=1) / det
            q = np.cross(from_a, e1)
            t = (along * q).sum(axis=1) / det
            share = (e2 * q).sum(axis=1) / det
            hit = across & (s >= -GRAZE) & (t >= -GRAZE) & (s + t <= 1 + GRAZE) & (share >= 0) & (share <= 1)
        found_segment.append(asked[hit])
        found_share.append(share[hit])
    return (np.concatenate(found_segment), np.concatenate(found_share)) if found_segment else nothing


def _through(points: np.ndarray, corners: np.ndarray, vertices: np.ndarray, triangles: np.ndarray, surface: _Sampled, grids: dict[Any, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Which of the triangles ``corners`` (three numbers of ``points`` each) go through a closed mesh, and where.

    A triangle goes through when one of its edges does: when, cut where it
    meets the mesh, the edge has a piece inside the mesh and a piece outside
    it. So an edge that only touches the mesh, at a corner of it or lying on
    a face, does not; one that goes in at one side of a wall and out at the
    other does, with both its ends outside. Where it goes through is the
    middle of the first piece of the edge that is inside. A part that goes
    through the middle of a triangle and meets none of its edges is not seen.
    """
    sides = np.sort(np.stack([corners[:, [0, 1]], corners[:, [1, 2]], corners[:, [2, 0]]], axis=1).reshape(-1, 2), axis=1)
    edges, of = np.unique(sides[:, 0] * len(points) + sides[:, 1], return_inverse=True)
    of = of.reshape(-1, 3)
    p = points[edges // len(points)]
    d = points[edges % len(points)] - p
    first, last = _clipped(p, d, vertices.min(axis=0) - TOUCH, vertices.max(axis=0) + TOUCH)
    meets = np.flatnonzero((first <= last) & (np.abs(d).max(axis=1) > 0))
    edge, share = _hits(p[meets], d[meets], first[meets], last[meets], surface)
    edge = meets[edge]
    none = np.zeros(len(corners), dtype=bool), np.zeros((0, 3))
    if len(edge) == 0:
        return none
    # Each edge that met the mesh, cut at its meetings: its ends, and the meetings between them, in order.
    met = np.unique(edge)
    edge = np.concatenate([edge, met, met])
    share = np.concatenate([share, np.zeros(len(met)), np.ones(len(met))])
    order = np.lexsort((share, edge))
    edge, share = edge[order], share[order]
    piece = (edge[1:] == edge[:-1]) & ((share[1:] - share[:-1]) * np.linalg.norm(d[edge[1:]], axis=1) > 2 * TOUCH)
    of_edge, middle = edge[1:][piece], (share[1:][piece] + share[:-1][piece]) / 2
    at = p[of_edge] + d[of_edge] * middle[:, None]
    clear = surface.nearest(at, 2 * TOUCH)[0] > TOUCH
    within = inside(at, vertices, triangles, grids)
    inner, outer = clear & within, clear & ~within
    goes = (np.bincount(of_edge[inner], minlength=len(edges)) > 0) & (np.bincount(of_edge[outer], minlength=len(edges)) > 0)
    if not goes.any():
        return none
    where = np.zeros((len(edges), 3))
    which, one = np.unique(of_edge[inner], return_index=True)
    where[which] = at[inner][one]
    through = goes[of]
    pierced = through.any(axis=1)
    return pierced, where[of[pierced, through[pierced].argmax(axis=1)]]


# What is asked


def _number(value: Any, default: float, least: float, most: float, name: str) -> float:
    if value is None:
        return default
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not least <= value <= most:
        raise QueryError("bad_request", f"{name} is a number from {least:g} to {most:g}")
    return float(value)


def _numbers(value: Any, count: int) -> bool:
    """Whether a value is that many numbers, each finite and no further out than a coordinate may be."""
    return isinstance(value, list) and len(value) == count and all(_is_coordinate(n) for n in value)


def _direction(value: Any, count: int = 3) -> np.ndarray | None:
    """Numbers as a direction of length one, whatever their size: None for what is not that many numbers, or has no direction.

    Each is divided by the largest of them first, so that numbers too large
    or too small to be squared still have their direction.
    """
    if not isinstance(value, list) or len(value) != count:
        return None
    try:
        if not all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in value):
            return None
        largest = max(abs(float(n)) for n in value)
    except OverflowError:  # an integer of hundreds of digits, which JSON may hold and no float can
        return None
    if largest == 0:
        return None
    scaled = np.array([float(n) / largest for n in value])
    return scaled / np.linalg.norm(scaled)


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
        only, ignore = said.get("only"), said.get("ignore")
        ignore = [] if ignore is None else ignore
        if not (only is None or isinstance(only, str)) or not isinstance(ignore, list) or not all(isinstance(path, str) for path in ignore):
            raise QueryError("bad_request", "of a scan, ignore is a list of the paths of masks and only the path of one")
        turn, move, size = self._transform(said.get("transform"))
        try:
            vertices, self.triangles, _ = scanfile.read_bin(said["path"])
        except (OSError, ValueError) as e:
            raise QueryError("bad_request", f"the mesh of {self.id} could not be read: {e}") from e
        self.points = vertices.astype(np.float64) @ turn.T * size + move
        if not (np.abs(self.points) <= FARTHEST).all():
            raise QueryError("bad_request", f"the transform of {self.id} puts it further out than {FARTHEST:g} mm")
        self.counts = np.ones(len(vertices), dtype=bool)
        try:
            if only is not None:
                self.counts = self._of(scanfile.read_mask(only, len(self.triangles)))
            for path in ignore:
                self.counts &= ~self._of(scanfile.read_mask(path, len(self.triangles)))
        except (OSError, ValueError) as e:
            raise QueryError("bad_request", f"a region of {self.id} could not be read: {e}") from e

    def _transform(self, said: Any) -> tuple[np.ndarray, np.ndarray, float]:
        """The turn, the move and the size of a transform ``{t, q, s}``: a point is made that size, turned, then moved."""
        refusal = QueryError("bad_request", f"the transform of {self.id} is not one: t is three numbers, q four that are not all zero, s more than zero")
        if not isinstance(said, dict):
            raise refusal
        t, q, s = said.get("t"), said.get("q"), said.get("s", 1)
        if not _numbers(t, 3) or not _numbers(q, 4) or not _is_coordinate(s) or not 1e-6 <= s <= 1e6:
            raise refusal
        # A quaternion need not be of length one, but one a million times off is no turn anyone meant.
        length = math.hypot(*map(float, q))
        if not 1e-6 <= length <= 1e6:
            raise refusal
        return tess._rotation([float(c) / length for c in q]), np.array(t, dtype=np.float64), float(s)

    def _of(self, mask: np.ndarray) -> np.ndarray:
        """The vertices of the triangles a region has."""
        vertices = np.zeros(len(self.points), dtype=bool)
        vertices[self.triangles[mask].reshape(-1)] = True
        return vertices

    def meeting(self, low: np.ndarray, high: np.ndarray) -> np.ndarray:
        """The triangles whose boxes meet a box, of those whose corners all count: a triangle may meet it with no corner in it."""
        out = np.zeros(len(self.points), dtype=np.uint8)
        for axis in range(3):
            out |= (self.points[:, axis] < low[axis]).astype(np.uint8) << (2 * axis)
            out |= (self.points[:, axis] > high[axis]).astype(np.uint8) << (2 * axis + 1)
        # Its box misses the other when all three corners are beyond the same side of it.
        beyond = out[self.triangles]
        return np.flatnonzero(((beyond[:, 0] & beyond[:, 1] & beyond[:, 2]) == 0) & self.counts[self.triangles].all(axis=1))


def _stamp(path: str) -> tuple[Any, ...]:
    """What tells a file from the one that was at its path before: written again, it is another file or of another time."""
    stat = os.stat(path)
    return path, stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size


def _scan(args: dict[str, Any], kept: dict[Any, Any]) -> _Scan:
    """The scan a query names, read once for as long as its file, its regions' files and what is asked of it are the same."""
    said = args.get("scan")
    try:
        only, ignore = said.get("only"), said.get("ignore") or []
        which = (_stamp(said["path"]), repr(said.get("transform")), None if only is None else _stamp(only), tuple(_stamp(path) for path in ignore))
    except (AttributeError, TypeError, KeyError, ValueError, OSError):
        which = None
    if which is None or kept.get("scan", (None, None))[0] != which:
        # One scan at a time is kept: Micra's points and triangles are 40 MB.
        kept.pop("scan", None)
        kept["scan"] = (which, _Scan(said))
    return kept["scan"][1]


def _mesh(shape: Any, key: str, kept: dict[Any, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The mesh a part is drawn with, and how many of its triangles each face has: worked out once."""
    if ("scan mesh", key) not in kept:
        kept["scan mesh", key] = tess.mesh_faces(shape)
    return kept["scan mesh", key]


def _surface(vertices: np.ndarray, triangles: np.ndarray, key: str, kept: dict[Any, Any]) -> _Sampled:
    """The part's mesh with the points that stand for it: worked out once."""
    if ("scan surface", key) not in kept:
        kept["scan surface", key] = _Sampled(vertices, triangles)
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


def _nth(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


# scan_clash


def clash(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    started = time.monotonic()
    layout, part, shape, key = _part(shapes, args)
    if not topo.solids(shape):
        raise QueryError("bad_request", f"{part} is not a solid: nothing is inside it; scan_deviation says how far it is from the scan")
    margin = _number(args.get("margin"), 5.0, 0.0, 50.0, "margin")
    scan = _scan(args, kept)
    vertices, triangles, _ = _mesh(shape, key, kept)
    low, high = vertices.min(axis=0), vertices.max(axis=0)
    near = np.flatnonzero(((scan.points >= low - margin) & (scan.points <= high + margin)).all(axis=1))
    ignored = int((~scan.counts[near]).sum())
    near = near[scan.counts[near]]
    every = max(1, -(-len(near) // MAX_CANDIDATES))
    checked = near[::every]
    grids = kept.setdefault(("scan grids", key), {})
    within = np.zeros(len(checked), dtype=bool)
    done = 0
    while done < len(checked) and time.monotonic() - started <= POINTS_SHARE * BUDGET:
        within[done : done + BATCH] = inside(scan.points[checked[done : done + BATCH]], vertices, triangles, grids)
        done = min(done + BATCH, len(checked))
    late = done < len(checked)
    checked, within = checked[:done], within[:done]
    points = scan.points[checked]
    surface = _surface(vertices, triangles, key, kept)
    # True where it matters that it is: of a point that may be on the surface. The rest only ranks the points to take on the B-rep.
    distance = surface.nearest(points, sure=surface.reach)[0]
    # A point on the mesh is on neither side of it: which side its ray said is chance.
    touching = distance <= TOUCH
    within &= ~touching

    # The scan's triangles that go through the part's surface, whether or not a vertex of theirs is inside it.
    meeting = scan.meeting(low, high)
    step = max(1, -(-len(meeting) // MAX_CANDIDATES))
    tried = meeting[::step]
    crossed = [np.zeros((0, 3))]
    tested = 0
    while tested < len(tried) and time.monotonic() - started <= EDGES_SHARE * BUDGET:
        crossed.append(_through(scan.points, scan.triangles[tried[tested : tested + EDGE_BATCH]], vertices, triangles, surface, grids)[1])
        tested = min(tested + EDGE_BATCH, len(tried))
    late = late or tested < len(tried)
    crossed = np.concatenate(crossed)
    at_least = step > 1 or tested < len(tried)
    group = clusters(crossed)
    groups = int(group.max()) + 1 if len(crossed) else 0
    crossings = [{"count": int((group == number).sum()), "centre": _xyz(crossed[group == number].mean(axis=0)), "bbox": _box(crossed[group == number])} for number in range(min(groups, MAX_CLUSTERS))]

    brep = _brep(shape, part, key, kept)
    taken: dict[int, Any] = {}
    failed = 0

    def again(n: int) -> dict[str, Any] | None:
        """A scan point taken on the B-rep, once: None when that failed, or there is no time or no turn left for it."""
        nonlocal failed, late
        if n in taken:
            return taken[n]
        if len(taken) >= MAX_RETAKEN:
            return None
        if time.monotonic() - started > BUDGET:
            late = True
            return None
        try:
            taken[n] = brep.nearest(part, key, _xyz(points[n]))
        except QueryError:
            failed += 1
            taken[n] = None
        return taken[n]

    def taken_again(candidates: np.ndarray, deepest: bool) -> dict[str, Any] | None:
        """Of a few scan points, the one deepest in the part or nearest to it by the B-rep, with what it is under."""
        best = None
        for n in candidates.tolist():
            found = again(n)
            if found is not None and (best is None or (found["distance"] > best[1]["distance"]) == deepest):
                best = (n, found)
        return None if best is None else {"at": _xyz(points[best[0]]), "on": best[1]["point"], "face": best[1]["ref"], "distance": best[1]["distance"]}

    inner, outer = np.flatnonzero(within), np.flatnonzero(~within)
    label = clusters(points[inner])
    count = int(label.max()) + 1 if len(inner) else 0
    # What the whole answer says first, while there is time: then each cluster's own.
    deepest = taken_again(inner[np.argsort(-distance[inner])[:3]], True)
    nearest = taken_again(outer[np.argsort(distance[outer])[:3]], False)
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
    for one in told:
        if "depth" in one and (deepest is None or one["depth"] > deepest["distance"]):
            deepest = {"distance": one["depth"], "at": one["at"], "face": one["under"]}
    how = [
        "scan vertices inside the part, by ray parity on the mesh the part is drawn with",
        "crossing counts the scan's triangles an edge of which goes through that mesh, whether or not a vertex is inside"
        + (f": at least, since only every {_nth(step)} of them was tried" if step > 1 else "")
        + (": at least, since the time ran out" if step == 1 and at_least else ""),
        "each depth and distance told is from that scan point to the part's B-rep",
    ]
    if failed:
        how.append(f"{failed} of the points it would have been told of could not be taken on the B-rep")
    if late:
        how.append(f"the time ran out after {done:,} vertices, {tested:,} triangles and {len(taken)} points on the B-rep")
    return {
        "part": part,
        "scan": scan.id,
        "points": {"scan": len(scan.points), "candidates": len(near), "checked": len(checked), "ignored": ignored, "touching": int(touching.sum())},
        "inside": {"count": len(inner), "crossing": len(crossed), "crossingAtLeast": at_least, "clusters": told, "clustersOmitted": max(0, count - MAX_CLUSTERS)},
        "crossings": {"triangles": {"candidates": len(meeting), "checked": tested, "every": step}, "clusters": crossings, "clustersOmitted": max(0, groups - MAX_CLUSTERS)},
        "deepest": None if deepest is None else {"depth": deepest["distance"], "at": deepest["at"], "under": deepest["face"]},
        "nearest": None if nearest is None else {"distance": nearest["distance"], "at": nearest["at"], "on": nearest["on"], "face": nearest["face"]},
        "sampling": {
            "every": every,
            "cell": CELL,
            "surface": surface.spacing,
            "deflection": kept.get(("deflection", key), tess.DEVIATION),
            "retaken": len(taken),
            "retakesFailed": failed,
            "partial": late,
            "seconds": round(time.monotonic() - started, 2),
        },
        "how": "; ".join(how),
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


def _few(count: int, wanted: int) -> np.ndarray:
    """``wanted`` numbers from 0 to ``count`` - 1, evenly, or all of them."""
    return np.unique(np.linspace(0, count - 1, min(wanted, count)).astype(np.int64)) if count else np.zeros(0, dtype=np.int64)


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
    numbers = np.flatnonzero(chosen)
    sampling: dict[str, Any] = {"deflection": kept.get(("deflection", key), tess.DEVIATION), "retakesFailed": 0, "partial": False}
    if source == "part":
        # Points of the part, each to the triangles of the scan: a scan of large triangles has few vertices to be near.
        _, sampling["surface"] = _spacing(vertices[triangles[chosen]], SURFACE, MAX_PART_SAMPLES)
        points, owner = sampled(vertices, triangles[chosen])
        some = _few(len(points), wanted)
        points, owner = points[some], numbers[owner[some]]
        of_scan = _Sampled(scan.points, scan.triangles[scan.meeting(points.min(axis=0) - within, points.max(axis=0) + within)], MAX_SCAN_SAMPLES)
        sampling["scanSurface"] = of_scan.spacing
        distance, there, _ = of_scan.nearest(points, within)
        # Where the scan is: its side of the part's surface is the sign.
        on_scan, other = there, there
        how = f"from {len(points):,} points of the part's mesh to the triangles of the scan"
    else:
        # Vertices of the scan, each to the triangles of the part's mesh.
        surface = _surface(vertices, triangles, key, kept) if faces is None else _Sampled(vertices, triangles[chosen])
        sampling["surface"] = surface.spacing
        box = vertices[triangles[chosen]].reshape(-1, 3)
        near = np.flatnonzero(scan.counts & ((scan.points >= box.min(axis=0) - within) & (scan.points <= box.max(axis=0) + within)).all(axis=1))
        points = on_scan = scan.points[near[_few(len(near), wanted)]]
        distance, other, on = surface.nearest(points, within)
        owner = numbers[np.maximum(on, 0)]
        how = f"from {len(points):,} vertices of the scan to the triangles of the part's mesh"
    compared = np.isfinite(distance)
    said: dict[str, Any] = {"part": part, "faces": faces, "scan": scan.id, "from": source, "samples": len(points), "compared": int(compared.sum()), "beyond": int((~compared).sum())}
    if not compared.any():
        sampling["seconds"] = round(time.monotonic() - started, 2)
        return {**said, "distance": None, "signed": None, "worst": None, "sampling": sampling, "how": f"{how}; nothing of the scan is within {within:g} mm", "exact": False}
    signed = None
    if solid:
        # The side is the scan's: where the scan's own point is inside the part, the distance counts as negative.
        scan_inside = inside(on_scan[compared], vertices, triangles, grids)
        signs = np.where(scan_inside, -1.0, 1.0) * distance[compared]
        signed = {"min": float(signs.min()), "mean": float(signs.mean()), "max": float(signs.max()), "inside": int(scan_inside.sum())}
        how += "; + where the scan is outside the part, − where it is inside"
    worst = int(np.flatnonzero(compared)[np.argmax(distance[compared])])
    told = {"distance": float(distance[worst]), "at": _xyz(points[worst]), "on": _xyz(other[worst]), "face": f"{part}/F{_face_of(per_face, int(owner[worst]))}"}
    if source == "scan":
        # One point of the scan, taken again on the B-rep: that distance is the part's own.
        try:
            found = _brep(shape, part, key, kept).nearest(part, key, _xyz(points[worst]))
            told = {"distance": found["distance"], "at": _xyz(points[worst]), "on": found["point"], "face": found["ref"]}
        except QueryError:
            sampling["retakesFailed"] = 1
            how += "; the furthest point could not be taken on the B-rep: its distance is to the part's mesh"
    sampling["seconds"] = round(time.monotonic() - started, 2)
    return {**said, "distance": _stats(distance[compared]), "signed": signed, "worst": told, "sampling": sampling, "how": how, "exact": False}


# scan_section


def _plane(args: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    plane = args.get("plane")
    origin = plane.get("origin") if isinstance(plane, dict) else None
    normal = _direction(plane.get("normal")) if isinstance(plane, dict) else None
    if not _numbers(origin, 3) or normal is None:
        raise QueryError("bad_request", "scan_section needs args.plane, with origin and normal, three numbers each, the normal not all zeros")
    return np.array(origin, dtype=np.float64), normal


def _chains(nodes: np.ndarray, ends: np.ndarray) -> list[tuple[float, bool, np.ndarray]]:
    """Segments joined end to end into polylines: the length, whether it closes, and the points of each.

    ``nodes`` is the place of each segment's two ends, as a number; ``ends``
    the two ends themselves.
    """
    at: dict[int, list[int]] = {}
    pairs = nodes.tolist()
    for segment, (one, other) in enumerate(pairs):
        at.setdefault(one, []).append(segment)
        at.setdefault(other, []).append(segment)
    unused = [True] * len(pairs)

    def walk(node: int, points: list[np.ndarray]) -> int:
        """Follow unused segments from a place, adding the far end of each: the place where none goes on."""
        while True:
            onward = next((s for s in at[node] if unused[s]), None)
            if onward is None:
                return node
            unused[onward] = False
            first = pairs[onward][0] == node
            node = pairs[onward][1 if first else 0]
            points.append(ends[onward, 1 if first else 0])

    lines = []
    for segment, (one, other) in enumerate(pairs):
        if not unused[segment]:
            continue
        unused[segment] = False
        ahead = [ends[segment, 0], ends[segment, 1]]
        closed = walk(other, ahead) == one and len(ahead) > 3
        if closed:
            ahead.pop()  # it came back to where it began
            points = np.array(ahead)
            length = float(np.linalg.norm(np.diff(np.vstack([points, points[:1]]), axis=0), axis=1).sum())
        else:
            behind: list[np.ndarray] = []
            walk(one, behind)
            points = np.array(behind[::-1] + ahead)
            length = float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
        lines.append((length, closed, points))
    return lines


def outline(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any]) -> dict[str, Any]:
    """Where a plane cuts a scan: polylines in the plane's own axes, as ``section`` gives a part's loops.

    Two segments are joined where their ends are in the same place, to a
    ten-thousandth of a millimetre: a scan with colours has several vertices
    in one place, wherever two patches of its texture meet. No more than
    ``MAX_OUTLINE_POINTS`` points are told in all: of more, each polyline
    keeps its share by its length, the longest first, and what does not fit
    is left out and counted.
    """
    from .section import _Frame

    layout = args.get("layout")
    if not isinstance(layout, str):
        raise QueryError("bad_request", "scan_section needs args.layout, a string")
    need_layout(shapes, layout)
    origin, normal = _plane(args)
    scan = _scan(args, kept)
    frame = _Frame(origin, normal)
    height = (scan.points - frame.origin) @ frame.normal
    side = height >= 0
    corners = scan.triangles[scan.counts[scan.triangles].all(axis=1)]
    corners = corners[side[corners].any(axis=1) & ~side[corners].all(axis=1)]
    # The corner that is alone on its side of the plane: the two edges from it go through the plane.
    alone = np.where(side[corners[:, 0]] != side[corners[:, 1]], np.where(side[corners[:, 0]] != side[corners[:, 2]], 0, 1), 2)
    rows = np.arange(len(corners))
    tip, left, right = corners[rows, alone], corners[rows, (alone + 1) % 3], corners[rows, (alone + 2) % 3]

    def through(one: np.ndarray, other: np.ndarray) -> np.ndarray:
        """Where the edge between two vertices goes through the plane: worked out from the lower side, so that it is the same from either."""
        below, above = np.where(side[one], other, one), np.where(side[one], one, other)
        share = (height[below] / (height[below] - height[above]))[:, None]
        return scan.points[below] + (scan.points[above] - scan.points[below]) * share

    cuts = np.stack([through(tip, left), through(tip, right)], axis=1)
    _, nodes = np.unique(np.round(cuts.reshape(-1, 3) / WELD).astype(np.int64), axis=0, return_inverse=True)
    nodes = nodes.reshape(-1, 2)
    real = nodes[:, 0] != nodes[:, 1]
    lines = _chains(nodes[real], frame.flat(cuts.reshape(-1, 3)).reshape(-1, 2, 2)[real])
    lines.sort(key=lambda line: -line[0])
    found = sum(len(points) for _, _, points in lines)
    whole = sum(length for length, _, _ in lines)
    told, room = [], MAX_OUTLINE_POINTS
    for length, closed, points in lines:
        keep = len(points)
        if found > MAX_OUTLINE_POINTS:
            keep = min(keep, max(3 if closed else 2, int(MAX_OUTLINE_POINTS * length / whole) if whole > 0 else 0))
        if keep > room:
            break
        if keep < len(points):
            # Evenly along it; an open one keeps both its ends.
            points = points[np.unique((np.arange(keep) * len(points) // keep) if closed else np.linspace(0, len(points) - 1, keep).round().astype(np.int64))]
        room -= len(points)
        told.append((closed, points))
    every = np.concatenate([points for _, points in told]) if told else None
    return {
        "scan": scan.id,
        "plane": {"origin": _xyz(frame.origin), "normal": _xyz(frame.normal), "x": _xyz(frame.x), "y": _xyz(frame.y)},
        "polylines": [{"points": [[float(u) + 0.0, float(v) + 0.0] for u, v in points], "closed": closed} for closed, points in told],
        "omitted": len(lines) - len(told),
        "segments": int(real.sum()),
        "pointsFound": found,
        "pointsTold": 0 if every is None else len(every),
        "thinned": every is not None and len(every) < found or (every is None and found > 0),
        "bounds": None if every is None else {"min": [float(c) for c in every.min(axis=0)], "max": [float(c) for c in every.max(axis=0)]},
        "exact": False,
    }
