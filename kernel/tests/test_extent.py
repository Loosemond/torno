"""A solid whose faces point inward is told as the broken thing it is, never as a sound volume."""

import math

import pytest

from torno_kernel import checks, extent, queries, topo
from torno_kernel.describe import descriptor
from torno_kernel.tess import build_scene


def inside_out(shape):
    """The same solid with its orientation reversed: OCC integrates it as negative and calls it valid."""
    from build123d import Solid

    return Solid(shape.wrapped.Reversed())


def cube_reversed():
    from build123d import Box

    return inside_out(Box(10, 10, 10))


def compound_with_a_reversed_cube():
    """A sound 10 mm cube and a reversed 5 mm one: OCC's signed sum is 875, the material 1125."""
    from build123d import Box, Compound, Pos

    return Compound([Box(10, 10, 10), Pos(30, 0, 0) * inside_out(Box(5, 5, 5))])


def test_the_probes_are_what_the_issue_says_they_are():
    for shape, signed in ((cube_reversed(), -1000), (compound_with_a_reversed_cube(), 875)):
        assert shape.volume == pytest.approx(signed)
        assert shape.is_valid


def test_a_reversed_cube_is_its_size_with_the_solid_named():
    volume = extent.volume(cube_reversed())
    assert volume.value == pytest.approx(1000)
    assert volume.exact is True
    assert volume.reversed == (0,)


def test_a_reversed_solid_among_sound_ones_is_not_taken_from_them():
    volume = extent.volume(compound_with_a_reversed_cube())
    assert volume.value == pytest.approx(1125)
    assert volume.exact is True
    # The index among the part's solids, 0-based, in OCC's order.
    assert volume.reversed == (1,)
    assert [s.Orientation().name for s in topo.solids(compound_with_a_reversed_cube().wrapped)][1] == "TopAbs_REVERSED"


def test_a_sound_part_has_nothing_reversed():
    from build123d import Box, Compound, Pos

    for shape in (Box(10, 10, 10), Compound([Box(10, 10, 10), Pos(30, 0, 0) * Box(5, 5, 5)])):
        assert extent.volume(shape).reversed == ()


def test_the_centre_is_of_the_material():
    from build123d import Box, Compound, Pos

    both = Compound([Box(10, 10, 10), Pos(30, 0, 0) * inside_out(Box(10, 10, 10))])
    volume, centre = extent.volume_and_centre(both)
    assert volume.value == pytest.approx(2000)
    assert (centre.X(), centre.Y(), centre.Z()) == pytest.approx((15, 0, 0))


def test_a_reversed_freeform_solid_is_integrated_and_named_too():
    from build123d import Sphere, scale

    ellipsoid = scale(Sphere(5), by=(1, 2, 3))
    volume = extent.volume(inside_out(ellipsoid))
    assert volume.exact is False
    assert volume.value == pytest.approx(4 / 3 * math.pi * 5 * 10 * 15, rel=1e-6)
    assert volume.reversed == (0,)
    assert extent.volume(ellipsoid).reversed == ()


def test_the_scene_names_the_reversed_solids_of_a_part_and_of_no_other():
    from build123d import Box

    scene, _, _ = build_scene(
        {"assembly": {"bad": cube_reversed(), "mixed": compound_with_a_reversed_cube(), "good": Box(10, 10, 10)}},
        "m.py",
    )
    parts = {p["name"]: p for p in scene["parts"]}
    assert (parts["bad"]["volume"], parts["bad"]["reversed"]) == (pytest.approx(1000), [0])
    assert (parts["mixed"]["volume"], parts["mixed"]["reversed"]) == (pytest.approx(1125), [1])
    # Absent, not empty, of a sound part: a sound scene is what it was.
    assert "reversed" not in parts["good"]


def shapes_of(**named):
    return {f"assembly:{name}": shape for name, shape in named.items()}


def test_describe_says_it():
    from build123d import Box

    shapes = shapes_of(bad=cube_reversed(), mixed=compound_with_a_reversed_cube(), good=Box(10, 10, 10))
    bad = queries.run(shapes, "describe", {"ref": "assembly:bad"}, {})
    assert (bad["volume"], bad["reversed"]) == (pytest.approx(1000), [0])
    assert "solid 0 reversed" in bad["descriptor"]
    mixed = queries.run(shapes, "describe", {"ref": "assembly:mixed"}, {})
    assert (mixed["volume"], mixed["reversed"]) == (pytest.approx(1125), [1])
    assert "solid 1 reversed" in mixed["descriptor"]
    good = queries.run(shapes, "describe", {"ref": "assembly:good"}, {})
    assert "reversed" not in good and "reversed" not in good["descriptor"]


def test_measure_volume_and_mass_say_it():
    shapes = shapes_of(mixed=compound_with_a_reversed_cube())
    for kind, more in (("volume", {}), ("mass", {"density": 1.0})):
        told = queries.run(shapes, "measure", {"kind": kind, "a": {"ref": "assembly:mixed"}, **more}, {})
        assert told["reversed"] == [1]
        assert "reversed" in told["how"]
    volume = queries.run(shapes, "measure", {"kind": "volume", "a": {"ref": "assembly:mixed"}}, {})
    assert volume["value"] == pytest.approx(1125)
    assert volume["exact"] is True


def test_measure_of_a_sound_part_is_what_it_was():
    from build123d import Box

    told = queries.run(shapes_of(good=Box(10, 10, 10)), "measure", {"kind": "volume", "a": {"ref": "assembly:good"}}, {})
    assert (told["value"], told["how"], told["exact"]) == (pytest.approx(1000), "of the solid", True)
    assert "reversed" not in told


def test_check_overlap_names_the_parts_with_a_reversed_solid():
    from build123d import Box, Pos

    shapes = shapes_of(a=Box(10, 10, 10), b=Pos(5, 0, 0) * Box(10, 10, 10), c=cube_reversed())
    sound = checks.check(shapes, {"kind": "overlap", "layout": "assembly", "a": "a", "b": "b"}, {})
    assert "reversed" not in sound
    told = checks.check(shapes, {"kind": "overlap", "layout": "assembly", "a": "a", "b": "c"}, {})
    assert told["reversed"] == ["c"]
    both = checks.check(shapes, {"kind": "overlap", "layout": "assembly", "a": "c", "b": "a"}, {})
    assert both["reversed"] == ["c"]


def test_the_descriptor_of_a_sound_part_is_unchanged():
    facts = {"bbox": {"min": [0, 0, 0], "max": [10, 10, 10]}, "faceCount": 6, "volume": 1000.0}
    assert descriptor("part", facts) == "part, 10 × 10 × 10 mm, 1000 mm³, 6 faces"


def test_a_solid_and_its_inside_out_twin_are_not_one_whichever_is_measured_first():
    from build123d import Box, Solid

    sound = Box(10, 10, 10)
    twin = Solid(sound.wrapped.Reversed())
    for first, second, reversed_first in ((sound, twin, ()), (twin, sound, (0,))):
        known: list = []
        assert extent.volume(first, known).reversed == reversed_first
        assert extent.volume(second, known).reversed == tuple(i for i in (0,) if not reversed_first)
        assert len(known) == 2
    # The same solid turned the same way is still integrated once.
    known = []
    extent.volume(sound, known)
    assert extent.volume(Solid(sound.wrapped), known) is known[0][1]
    assert len(known) == 1


def test_the_budget_for_refining_a_volume_is_the_part_s_and_not_each_solid_s(monkeypatch):
    from build123d import Compound, Pos, Sphere, scale

    asked: list[float] = []
    clock = [0.0]
    integrate = extent._gauss_kronrod

    def counted(wrapped, tolerance, centre):
        asked.append(tolerance)
        clock[0] += 0.06
        return integrate(wrapped, tolerance, centre)

    monkeypatch.setattr(extent, "_gauss_kronrod", counted)
    monkeypatch.setattr(extent, "_clock", lambda: clock[0])
    four = Compound([Pos(30 * i, 0, 0) * scale(Sphere(5), by=(1, 2, 3)) for i in range(4)])
    assert len(topo.solids(four)) == 4
    volume = extent.volume(four)
    first = extent.VOLUME_TOLERANCES[0]
    # The four first integrals took the 0.1 s the part has: no solid is refined, none is left behind.
    assert asked == [first] * 4
    assert volume.exact is False and volume.value == pytest.approx(4 * 4 / 3 * math.pi * 5 * 10 * 15, rel=1e-3)
    # Cheaper integrals go on together, all the solids one tolerance after another, while the part's total
    # is under the budget: as many levels as a single solid of the same cost would have.
    del asked[:]
    clock[0] = 0.0

    def cheaper(wrapped, tolerance, centre):
        asked.append(tolerance)
        clock[0] += 0.01
        return integrate(wrapped, tolerance, centre)

    monkeypatch.setattr(extent, "_gauss_kronrod", cheaper)
    extent.volume(four)
    assert asked == [tolerance for tolerance in extent.VOLUME_TOLERANCES[:3] for _ in range(4)]
