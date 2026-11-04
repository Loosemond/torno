import json
import sys
from pathlib import Path

import pytest

from torno_kernel import queries
from torno_kernel.loader import choose_model, load_model, load_scene

# The example the first screen offers (app/resources/example): a project made to be shown, kept with its brief,
# its marks and its views. It must build as it says, and what its marks point at must be there.
EXAMPLE = Path(__file__).parents[2] / "app" / "resources" / "example" / "enclosure"


@pytest.fixture(scope="module")
def shapes():
    # Importing the model must leave nothing in the example (the kernel runs with PYTHONDONTWRITEBYTECODE).
    sys.dont_write_bytecode = True
    scene =load_scene(EXAMPLE, choose_model(EXAMPLE).name)
    return {f"{layout}:{name}": shape for layout, parts in scene.items() for name, shape in parts.items()}


def test_the_example_has_one_model_and_a_brief():
    assert choose_model(EXAMPLE).name == "enclosure.py"
    assert (EXAMPLE / "brief.md").read_text().startswith("# enclosure")


def test_the_example_builds_both_layouts_of_three_valid_solids(shapes):
    assert sorted(shapes) == sorted(f"{layout}:{part}" for layout in ("assembly", "print") for part in ("case-body", "case-lid", "clip"))
    for key, shape in shapes.items():
        assert shape.is_valid, key
        assert len(shape.solids()) == 1, key
        assert shape.volume > 0, key


def test_the_example_is_put_together_without_touching_and_printed_on_the_bed(shapes):
    body, lid, clip = (shapes[f"assembly:{name}"] for name in ("case-body", "case-lid", "clip"))
    for a, b in ((body, lid), (body, clip), (lid, clip)):
        common = a.intersect(b)
        assert common is None or common.volume == pytest.approx(0, abs=1e-6)
    for name in ("case-body", "case-lid", "clip"):
        assert shapes[f"print:{name}"].bounding_box().min.Z == pytest.approx(0, abs=1e-6)


def test_the_example_has_its_group():
    assert load_model(EXAMPLE, "enclosure.py")[2] == [{"name": "case", "parts": ["case-body", "case-lid"]}]


def test_what_the_marks_of_the_example_point_at_is_there_and_one_dimension_fails(shapes):
    file = json.loads((EXAMPLE / ".torno" / "marks.json").read_text())
    assert [m["id"] for m in file["marks"]] == ["M1", "M2", "M3"] and file["next"] == 4
    kept: dict = {}
    for mark in file["marks"]:
        for anchor in [mark.get(k) for k in ("anchor", "from", "a", "b")]:
            if anchor is None:
                continue
            found = queries.nearest(shapes, mark["layout"], [{"part": anchor["part"], "point": anchor["point"]}], kept)[0]
            assert found["ref"] == anchor["ref"] and found["descriptor"] == anchor["descriptor"], mark["id"]
            assert found["distance"] == pytest.approx(0, abs=1e-6), mark["id"]
    dimension = file["marks"][2]
    assert dimension["kind"] == "dimension" and dimension["expected"] == 0.2
    measured = queries.run(
        shapes,
        "measure",
        {"kind": "distance", "a": {"ref": f"assembly:{dimension['a']['ref']}"}, "b": {"ref": f"assembly:{dimension['b']['ref']}"}},
        kept,
    )
    # The lid's clearance is 0.35 mm, not the 0.2 that was asked for: the example's dimension fails, for the agent to put right.
    assert measured["value"] == pytest.approx(0.35)
    assert abs(measured["value"] - dimension["expected"]) > dimension["tolerance"]


def test_the_views_of_the_example_name_parts_it_has(shapes):
    scene = json.loads((EXAMPLE / ".torno" / "scene.json").read_text())
    assert [v["name"] for v in scene["views"]] == ["Lid fit", "Cable side"]
    parts = {key.split(":", 1)[1] for key in shapes}
    for view in scene["views"]:
        assert set(view["hidden"]) <= parts
        assert any(key.startswith(f"{view['layout']}:") for key in shapes)
