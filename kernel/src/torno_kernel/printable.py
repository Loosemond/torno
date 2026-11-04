"""Will a part print: the ``check`` kinds ``overhang``, ``thin`` and ``bed``.

Of the shapes as the build placed them, in the layout asked (the app asks the
``print`` layout), Z up, the bed at the lowest point of the part. A face is
named as a ref of its part, ``tray/F7``, in the kernel's order (``topo``).
"""

import math
import time
from typing import Any

from . import extent, topo
from .queries import QueryError, box_of, boxed_exactly_of, is_reference, need_layout, need_made, need_solid

# Faces whose highest point is within this of the lowest of the part, mm, rest on the bed.
ON_BED = 0.01
# A curved face is judged by its normals at this many points a side of its parameters.
NORMAL_SAMPLES = 9
# A wall is measured at this many points a side of each face's parameters.
WALL_SAMPLES = 5
# What ``thin`` may take, s, of the 30 a query has; past it the faces left are told as not measured.
THIN_BUDGET = 10.0
# A wall thinner than this is the face the ray starts on, mm.
_OWN_FACE = 1e-6
# How far a ray is followed, mm.
_REACH = 1e7
# At most so many faces are told; the rest are counted.
MAX_FACES = 200


def overhang(shape: Any, part: str, key: str, angle: Any, kept: dict[Any, Any]) -> dict[str, Any]:
    """The faces of ``part`` that face down steeper than ``angle`` degrees from vertical.

    A face overhangs where its outward normal ``n`` has ``n·(−Z) > sin(angle)``:
    a vertical wall does not, a ceiling does. Faces that rest on the bed (all of
    them within ``ON_BED`` of the part's lowest point) do not. Of a plane that
    is exact. A curved face is judged by its normals at ``NORMAL_SAMPLES`` ×
    ``NORMAL_SAMPLES`` points of it, and is told with ``exact`` false: a
    steeper place between them can be missed. ``steepest`` is the most a face
    leans from vertical, degrees (90 is a ceiling); its ``area`` is the whole
    face's, as ``describe`` tells it.
    """
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not 0 < angle < 90:
        raise QueryError("bad_request", "check overhang takes angle, degrees from vertical, above 0 and below 90")
    need_solid(shape, part)
    need_made(kept, key, part, "an overhang")
    limit = math.sin(math.radians(angle))
    low = box_of(shape, key, kept)[0][2]
    found = []
    for index, face in enumerate(topo.faces(shape)):
        planar = _is_plane(face)
        normals = [_plane_normal(face)] if planar else [n for _, n in _sampled(face, NORMAL_SAMPLES)]
        downs = [-n[2] for n in normals if n is not None]
        if not downs:
            continue
        down = max(downs)
        if down <= limit + 1e-12:
            continue
        if extent.box(face)[1][2] - low <= ON_BED:
            continue
        area = extent.area_at_a_glance(face)
        found.append(
            {
                "ref": f"{part}/F{index}",
                "area": area.value,
                "areaExact": area.exact,
                "steepest": math.degrees(math.asin(min(1.0, down))),
                "exact": planar,
            }
        )
    exact = all(f["exact"] and f["areaExact"] for f in found)
    how = "faces facing down steeper than the angle from vertical; faces on the bed left out"
    if not all(f["exact"] for f in found):
        how += "; curved faces judged by their normals at sampled points, approximate"
    return {
        "part": part,
        "angle": angle,
        "faces": found[:MAX_FACES],
        "count": len(found),
        "area": math.fsum(f["area"] for f in found),
        "exact": exact,
        "how": how,
    }


def thin(shape: Any, part: str, key: str, least: Any, kept: dict[Any, Any]) -> dict[str, Any]:
    """Where the wall of ``part`` is thinner than ``least`` mm, by sampling.

    At ``WALL_SAMPLES`` × ``WALL_SAMPLES`` points of each face, away from its
    borders, the wall is measured as ``measure thickness`` does: along the
    inward normal to where the part ends. A face is told when any of its points
    is thinner than ``least``, with the thinnest of them. Never exact: a
    thinner place between the points can be missed. ``thinnest`` is the
    thinnest wall measured anywhere, thin or not. ``sampling`` says how many
    faces and points were measured, and whether the time (``THIN_BUDGET``)
    ran out first.
    """
    if isinstance(least, bool) or not isinstance(least, (int, float)) or not 0 < least < 1e6:
        raise QueryError("bad_request", "check thin needs min, the least wall in mm, a number above 0")
    need_solid(shape, part)
    need_made(kept, key, part, "a wall too thin to print")
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

    rays = _rays(shape, key, kept)
    started = time.monotonic()
    faces = topo.faces(shape)
    found = []
    thinnest = None
    measured = points = faces_done = 0
    complete = True
    for index, face in enumerate(faces):
        if time.monotonic() - started > THIN_BUDGET:
            complete = False
            break
        faces_done += 1
        worst = None
        for at, normal in _sampled(face, WALL_SAMPLES):
            points += 1
            if normal is None:
                continue
            start = gp_Pnt(*at)
            rays.Perform(gp_Lin(start, gp_Dir(-normal[0], -normal[1], -normal[2])), _OWN_FACE, _REACH)
            hits = range(1, rays.NbPnt() + 1) if rays.IsDone() else ()
            first = min(hits, key=rays.WParameter, default=None)
            if first is None:
                continue
            measured += 1
            wall = float(rays.WParameter(first))
            if worst is None or wall < worst[0]:
                hit = rays.Pnt(first)
                worst = (wall, [list(at), [hit.X() + 0.0, hit.Y() + 0.0, hit.Z() + 0.0]])
        if worst is None:
            continue
        ref = f"{part}/F{index}"
        if thinnest is None or worst[0] < thinnest["value"]:
            thinnest = {"value": worst[0], "ref": ref, "points": worst[1]}
        if worst[0] < least:
            found.append({"ref": ref, "thinnest": worst[0], "points": worst[1]})
    how = (
        f"approximate: walls along the inward normal at {WALL_SAMPLES} × {WALL_SAMPLES} points of each face; "
        "a thinner place between them can be missed"
    )
    if not complete:
        how += f"; the time ran out after {faces_done} of {len(faces)} faces"
    return {
        "part": part,
        "min": least,
        "faces": found[:MAX_FACES],
        "count": len(found),
        "thinnest": thinnest,
        "exact": False,
        "how": how,
        "sampling": {"faces": faces_done, "of": len(faces), "points": points, "measured": measured, "complete": complete},
    }


def bed(shapes: dict[str, Any], layout: str, size: Any, kept: dict[Any, Any]) -> dict[str, Any]:
    """Whether the parts of ``layout``, as placed, fit a bed of ``size`` [x, y, z] mm.

    The box of the layout is that of its parts' boxes, each as the scene tells
    it (``tess.part_box``); ``over`` is by how much it is larger than the bed
    along each axis, 0 where it is not. Exact only when every part's box is.
    """
    if (
        not isinstance(size, list)
        or len(size) != 3
        or not all(isinstance(s, (int, float)) and not isinstance(s, bool) and 0 < s < 1e6 for s in size)
    ):
        raise QueryError("bad_request", "check bed needs size, the bed's [x, y, z] in mm, three numbers above 0")
    need_layout(shapes, layout)
    # A reference is bought, not printed: it takes no room on the bed.
    keys = [k for k in shapes if k.startswith(f"{layout}:") and not is_reference(kept, k)]
    left_out = [k.split(":", 1)[1] for k in shapes if k.startswith(f"{layout}:") and is_reference(kept, k)]
    if not keys:
        raise QueryError("bad_request", f"{layout} has no part to make: its parts are references (bought)")
    lows, highs, exact = [], [], True
    for k in keys:
        low, high = box_of(shapes[k], k, kept)
        lows.append(low)
        highs.append(high)
        exact = exact and boxed_exactly_of(shapes[k], k, kept)
    low = [min(p[i] for p in lows) for i in range(3)]
    high = [max(p[i] for p in highs) for i in range(3)]
    extent_ = [high[i] - low[i] + 0.0 for i in range(3)]
    over = [max(0.0, extent_[i] - size[i]) + 0.0 for i in range(3)]
    return {
        "layout": layout,
        "parts": [k.split(":", 1)[1] for k in keys],
        "bed": list(size),
        "size": extent_,
        "bbox": {"min": low, "max": high},
        "fits": not any(over),
        "over": over,
        "exact": exact,
        "how": "the box of the layout's parts as placed, against the bed"
        + ("" if exact else "; approximate: a part's box is exact only of planes and cylinders"),
        **({"references": left_out} if left_out else {}),
    }


def _is_plane(face: Any) -> bool:
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane

    return BRepAdaptor_Surface(face).GetType() == GeomAbs_Plane


def _plane_normal(face: Any) -> list[float] | None:
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.TopAbs import TopAbs_REVERSED

    direction = BRepAdaptor_Surface(face).Plane().Axis().Direction()
    sign = -1.0 if face.Orientation() == TopAbs_REVERSED else 1.0
    return [sign * direction.X(), sign * direction.Y(), sign * direction.Z()]


def _sampled(face: Any, n: int) -> list[tuple[list[float], list[float] | None]]:
    """Points of a face on an ``n`` × ``n`` grid of its parameters, away from their ends, with the outward normal at each.

    Only those inside the face: a grid point in a hole or past a trimmed edge
    is passed over. A point where the normal is not defined has None.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.BRepTools import BRepTools
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN, TopAbs_REVERSED

    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
    surface = BRepAdaptor_Surface(face)
    inside = BRepClass_FaceClassifier()
    sign = -1.0 if face.Orientation() == TopAbs_REVERSED else 1.0
    found = []
    for i in range(n):
        for j in range(n):
            u = u0 + (u1 - u0) * (i + 0.5) / n
            v = v0 + (v1 - v0) * (j + 0.5) / n
            inside.Perform(face, gp_Pnt2d(u, v), 1e-7)
            if inside.State() != TopAbs_IN:
                continue
            props = BRepLProp_SLProps(surface, u, v, 1, 1e-7)
            point = props.Value()
            at = [point.X() + 0.0, point.Y() + 0.0, point.Z() + 0.0]
            if not props.IsNormalDefined():
                found.append((at, None))
                continue
            normal = props.Normal()
            found.append((at, [sign * normal.X(), sign * normal.Y(), sign * normal.Z()]))
    return found


def _rays(shape: Any, key: str, kept: dict[Any, Any]) -> Any:
    """What a line is cut with to find where it meets the part: made once per part, shared with ``measure``."""
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector

    held = ("rays", key)
    if held not in kept:
        kept[held] = IntCurvesFace_ShapeIntersector()
        kept[held].Load(getattr(shape, "wrapped", shape), 1e-7)
    return kept[held]
