"""A build123d selector that picks a face or an edge now (``describe`` with ``selector``)."""

import re

import pytest
from build123d import Axis, Box, Compound, Cylinder, GeomType, Pos, Rot, fillet

from torno_kernel import queries, selectors, topo
from torno_kernel.tess import build_scene


def shapes_of(part, name="plate"):
    _, _, shapes = build_scene({"main": {name: part}}, f"{name}.py")
    return shapes


def described(shapes, ref, name="plate"):
    return queries.run(shapes, "describe", {"ref": f"main:{name}/{ref}", "selector": True})


def evaluated(expression, part):
    """What the expression gives on the part, evaluated as an agent's model would: the real names of build123d."""
    import build123d

    return eval(expression, {**vars(build123d), "part": part})  # noqa: S307 - the tests' own expressions


@pytest.fixture(scope="module")
def plate():
    """A 40 × 30 × 5 plate with a 4 mm hole and a 2 mm hole through it."""
    return Box(40, 30, 5) - Pos(10, 0, 0) * Cylinder(4, 5) - Pos(-10, 0, 0) * Cylinder(2, 5)


@pytest.fixture(scope="module")
def built(plate):
    return shapes_of(plate)


def every_ref(shapes, key="main:plate"):
    name = key.split(":")[1]
    part = shapes[key]
    return [f"F{i}" for i in range(len(topo.faces(part)))] + [f"E{i}" for i in range(len(topo.edges(part)))]


# Each selector, evaluated, gives the one shape


def test_every_selector_given_picks_exactly_that_face_or_edge(built, plate):
    told = 0
    for ref in every_ref(built):
        reply = described(built, ref)
        selector = reply["selector"]
        if selector is None:
            continue
        told += 1
        topods = topo.faces(plate)[int(ref[1:])] if ref[0] == "F" else topo.edges(plate)[int(ref[1:])]
        picked = evaluated(selector["expression"], plate)
        assert picked.wrapped.IsSame(topods), (ref, selector)
        assert selector["robust"] in ("by geometry", "by order") and selector["checked"] == "this build only"
    # Every face and every edge of this plate can be told apart: none was left without one.
    assert told == len(every_ref(built))


def test_the_top_of_a_plate_is_the_extreme_of_its_planar_faces_across_z(built):
    top = next(f"F{i}" for i, f in enumerate(topo.faces(built["main:plate"])) if _is_top(f))
    reply = described(built, top)
    assert reply["selector"] == {
        "expression": "part.faces().filter_by(Axis.Z).sort_by(Axis.Z)[-1]",
        "robust": "by geometry",
        "checked": "this build only",
    }
    assert "descriptor" in reply and reply["kind"] == "face"


def _is_top(face):
    from build123d import Face

    face = Face(face)
    return face.geom_type == GeomType.PLANE and face.normal_at().Z > 0.99


def test_a_side_face_is_picked_by_its_direction_and_an_extreme(built):
    sides = {}
    for i, f in enumerate(topo.faces(built["main:plate"])):
        from build123d import Face

        face = Face(f)
        if face.geom_type == GeomType.PLANE and abs(face.normal_at().X) > 0.99:
            sides[face.center().X > 0] = f"F{i}"
    right = described(built, sides[True])["selector"]
    assert right["expression"] == "part.faces().filter_by(Axis.X).sort_by(Axis.X)[-1]"
    assert described(built, sides[False])["selector"]["expression"] == "part.faces().filter_by(Axis.X).sort_by(Axis.X)[0]"


def test_a_hole_is_picked_by_its_radius(built, plate):
    radii = {}
    for i, f in enumerate(topo.faces(plate)):
        from build123d import Face

        face = Face(f)
        if face.geom_type == GeomType.CYLINDER:
            radii[round(face.radius)] = f"F{i}"
    big = described(built, radii[4])["selector"]
    assert big["robust"] == "by geometry"
    assert "abs(f.radius - 4)" in big["expression"] or "sort_by" in big["expression"]


def test_an_edge_is_picked_too(built, plate):
    circles = [i for i, e in enumerate(topo.edges(plate)) if _kind(e) == "CIRCLE"]
    assert len(circles) == 4
    for i in circles:
        reply = described(built, f"E{i}")
        assert reply["kind"] == "edge" and reply["selector"] is not None
        assert evaluated(reply["selector"]["expression"], plate).wrapped.IsSame(topo.edges(plate)[i])
    vertical = [i for i, e in enumerate(topo.edges(plate)) if _kind(e) == "LINE" and abs(_along_z(e)) > 0.99]
    assert vertical
    assert "Axis.Z" in described(built, f"E{vertical[0]}")["selector"]["expression"] or "GeomType.LINE" in described(built, f"E{vertical[0]}")["selector"]["expression"]


def test_vertical_edges_that_tie_on_one_axis_are_told_by_two_extremes(built, plate):
    from build123d import Edge

    corners = {}
    for i, e in enumerate(topo.edges(plate)):
        edge = Edge(e)
        if edge.geom_type == GeomType.LINE and abs(edge.tangent_at(0.5).Z) > 0.99 and abs(edge.center().X) > 19:
            corners[(edge.center().X > 0, edge.center().Y > 0)] = i
    assert len(corners) == 4
    expressions = {key: described(built, f"E{i}")["selector"]["expression"] for key, i in corners.items()}
    assert expressions[(False, False)] == "part.edges().filter_by(Axis.Z).group_by(Axis.X)[0].sort_by(Axis.Y)[0]"
    assert expressions[(True, True)] == "part.edges().filter_by(Axis.Z).group_by(Axis.X)[-1].sort_by(Axis.Y)[-1]"
    for key, i in corners.items():
        assert evaluated(expressions[key], plate).wrapped.IsSame(topo.edges(plate)[i])


def _kind(edge):
    from build123d import Edge

    return Edge(edge).geom_type.name


def _along_z(edge):
    from build123d import Edge

    return Edge(edge).tangent_at(0.5).Z


# A filleted plate: four equal fillets cannot be told by one extreme, and are by two


def test_equal_fillets_are_told_by_two_extremes():
    from build123d import Face

    base = Box(40, 30, 5)
    rounded = fillet(base.edges().filter_by(Axis.Z), 3)
    shapes = shapes_of(rounded)
    fillets = [i for i, f in enumerate(topo.faces(rounded)) if Face(f).geom_type == GeomType.CYLINDER]
    assert len(fillets) == 4
    for i in fillets:
        selector = described(shapes, f"F{i}")["selector"]
        assert selector["robust"] == "by geometry" and ".group_by(" in selector["expression"]
        assert evaluated(selector["expression"], rounded).wrapped.IsSame(topo.faces(rounded)[i])


# What cannot be told


def test_a_face_that_is_the_same_as_another_gets_none_and_the_reply_says_so():
    twice = Compound([Box(10, 10, 10), Box(10, 10, 10)])
    shapes = shapes_of(twice, "twin")
    reply = described(shapes, "F0", "twin")
    assert reply["selector"] is None
    assert "no selector picks only this face" in reply["selectorWhy"]
    assert reply["descriptor"].startswith("plane")


def test_a_place_in_a_sort_is_told_by_order(monkeypatch, built, plate):
    # Where nothing else can tell it, only an index into a sort can, and it says the next edit may break it.
    original = selectors._Search._candidates

    def only_by_order(self, facts):
        return (c for c in original(self, facts) if c[0] == "by order")

    monkeypatch.setattr(selectors._Search, "_candidates", only_by_order)
    reply = described(built, "F0")
    selector = reply["selector"]
    if selector is not None:
        assert selector["robust"] == "by order" and re.search(r"\.sort_by\(Axis\.[XYZ]\)\[-?\d+\]$", selector["expression"])
        assert evaluated(selector["expression"], plate).wrapped.IsSame(topo.faces(plate)[0])


def test_no_selector_is_told_of_a_part(built):
    reply = queries.run(built, "describe", {"ref": "main:plate", "selector": True})
    assert "selector" not in reply


def test_describe_asks_for_a_selector_only_when_it_is_asked_for(built):
    assert "selector" not in queries.run(built, "describe", {"ref": "main:plate/F0"})
    assert "selector" not in queries.run(built, "describe", {"ref": "main:plate/F0", "selector": "yes"})


# The expression is the worker's own

PREFIX = re.compile(r"part\.(faces|edges)\(\)")
FIXED = re.compile(
    r"\.filter_by\((?:Axis\.[XYZ]|GeomType\.[A-Z_]+)\)"
    r"|\.sort_by\(Axis\.[XYZ]\)"
    r"|\.group_by\(Axis\.[XYZ]\)\[-?\d+\]"
)
LAMBDA = re.compile(r"\.filter_by\(lambda [fe]: ")
INDEX = re.compile(r"\[-?\d+\]")


def well_formed(expr):
    """Whether ``expr`` is a part's faces or edges, a fixed run of filters, sorts and groups, and an index.

    A lambda's body is anything but ';' up to a ')', so it may hold ').filter_by(lambda e: ' itself, and a regex
    that lets the body run on backtracks exponentially over that. Here the text from each position is decided
    once, from the end: ok[j] says the text from j is a run of items and then the final index; a lambda's body
    ends at the first ')' from it on after which the rest is ok (nxt[j]), with no ';' between.
    """
    if expr.endswith("\n"):  # the pattern's '$' also matched before a final newline
        expr = expr[:-1]
    head = PREFIX.match(expr)
    if head is None:
        return False
    start, n = head.end(), len(expr)
    ok = [False] * (n + 1)
    nxt = [n + 1] * (n + 1)  # first ')' at or after j that ends a lambda's body and leaves an ok rest; n + 1 if none
    semi = [n] * (n + 1)  # first ';' at or after j, or n
    for j in range(n, start - 1, -1):
        index = INDEX.match(expr, j)
        if index is not None and index.end() == n:
            ok[j] = True
        item = FIXED.match(expr, j)
        if item is not None and ok[item.end()]:
            ok[j] = True
        lam = LAMBDA.match(expr, j)
        if lam is not None and nxt[lam.end()] < semi[lam.end()]:
            ok[j] = True
        if j < n:
            nxt[j] = j if expr[j] == ")" and ok[j + 1] else nxt[j + 1]
            semi[j] = j if expr[j] == ";" else semi[j + 1]
    return ok[start]


def test_the_expression_is_made_of_a_fixed_set_of_names_and_numbers(built):
    for ref in every_ref(built):
        selector = described(built, ref)["selector"]
        assert selector is not None and well_formed(selector["expression"]), selector


def test_the_evaluation_has_no_builtins_but_abs(plate):
    search = selectors._Search(plate, topo.faces(plate)[0], "face", float("inf"), lambda: 0.0)
    assert search.globals["__builtins__"] == {"abs": abs}
    with pytest.raises(NameError):
        eval("__import__('os')", search.globals)  # noqa: S307
    with pytest.raises(NameError):
        eval("open('/etc/passwd')", search.globals)  # noqa: S307


def test_a_ref_is_never_in_the_expression(built):
    reply = described(built, "F1")
    assert "plate" not in reply["selector"]["expression"].replace("part.", "")


# The part as it stands in the layout


def test_the_selector_is_of_the_part_where_it_stands_in_the_layout():
    # Turned on its side in the layout, the top of the plate as built is an extreme along X there.
    built = Box(40, 30, 5)
    turned = Rot(0, 90, 0) * built
    shapes = shapes_of(turned)
    top = next(i for i, f in enumerate(topo.faces(turned)) if _is_top(f) is False and abs(_normal(f).X) > 0.99 and _normal(f).X > 0)
    reply = described(shapes, f"F{top}")
    assert reply["selector"]["expression"] == "part.faces().filter_by(Axis.X).sort_by(Axis.X)[-1]"
    assert evaluated(reply["selector"]["expression"], turned).wrapped.IsSame(topo.faces(turned)[top])


def _normal(face):
    from build123d import Face

    return Face(face).normal_at()


# The time it takes


def test_a_search_past_its_time_says_so(plate):
    reply = selectors.selector_for(plate, topo.faces(plate)[0], "face", budget=0)
    assert reply == {"selector": None, "selectorWhy": "the search for one ran out of time"}


def test_a_selector_is_found_quickly_on_a_part_of_many_faces():
    import time

    many = Box(200, 200, 10)
    for i in range(10):
        for j in range(10):
            many = many - Pos(-60 + i * 13, -60 + j * 13, 0) * Cylinder(2, 10)
    shapes = shapes_of(many)
    faces = topo.faces(many)
    assert len(faces) > 100
    started = time.monotonic()
    reply = described(shapes, f"F{len(faces) // 2}")
    assert reply["selector"] is not None
    assert time.monotonic() - started < 3.0


# Through the kernel


def test_the_kernel_answers_describe_with_a_selector_when_asked(tmp_path):
    from kclient import Kernel

    folder = tmp_path / "plate"
    folder.mkdir()
    (folder / "plate.py").write_text("from build123d import *\nplate = Box(40, 30, 5) - Cylinder(4, 5)\n")
    kernel = Kernel()
    try:
        reply, _ = kernel.build(folder, "plate.py", timeout=30)
        assert reply["ok"] is True
        asked = kernel.query(folder, "describe", {"ref": "main:plate/F2", "selector": True})
        plain = kernel.query(folder, "describe", {"ref": "main:plate/F2"})
    finally:
        kernel.close()
    assert asked["ok"] is True and asked["result"]["selector"]["robust"] == "by geometry"
    assert asked["result"]["selector"]["expression"].startswith("part.faces()")
    assert plain["ok"] is True and "selector" not in plain["result"]
