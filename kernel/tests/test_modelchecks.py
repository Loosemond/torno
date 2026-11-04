"""The model's own ``checks(p)``: read by the loader, measured by ``modelchecks`` after the build."""

import re
import sys
from pathlib import Path

import pytest

from torno_kernel import modelchecks, worker
from torno_kernel.loader import LoadError, load_model
from torno_kernel.tess import build_scene

MODEL = '''
from dataclasses import dataclass
from build123d import Box, Pos

@dataclass(frozen=True)
class Params:
    clearance: float = 0.15

def assembly(p):
    return {
        "tub": Box(20, 20, 10),
        "lid": Pos(20 + p.clearance, 0, 0) * Box(20, 20, 10),
        "pad": Pos(10, 0, 0) * Box(4, 4, 4),
        "mushroom": Pos(0, 60, 0) * (Box(10, 10, 10) + Pos(0, 0, 10) * Box(30, 30, 4)),
        "pair": Pos(0, -60, 0) * (Box(10, 10, 10) + Pos(30, 0, 0) * Box(10, 10, 10)),
    }

def groups(p):
    return {"shell": ["tub", "lid"]}

def checks(p):
    return CHECKS
'''


@pytest.fixture(autouse=True)
def no_bytecode(monkeypatch):
    # The same model file rewritten in one second with a source of the same size would be read from its cache.
    monkeypatch.setattr(sys, "dont_write_bytecode", True)


def load(tmp_path: Path, declarations: str):
    (tmp_path / "m.py").write_text(MODEL.replace("CHECKS", declarations))
    return load_model(tmp_path, "m.py")


def measured(tmp_path: Path, declarations: str, budget: float = modelchecks.BUDGET):
    layouts, _, groups, declared = load(tmp_path, declarations)
    _, _, shapes = build_scene(layouts, "m.py", {})
    return modelchecks.run(declared, shapes, groups, {}, budget)


def one(tmp_path: Path, declaration: str) -> dict:
    return measured(tmp_path, f"[{declaration}]")[0]


def test_a_model_without_checks_declares_none(tmp_path):
    (tmp_path / "m.py").write_text(MODEL.replace("def checks(p):\n    return CHECKS\n", ""))
    assert load_model(tmp_path, "m.py")[3] == []


def test_declarations_are_read_in_order_as_json_says_them(tmp_path):
    _, _, _, declared = load(
        tmp_path,
        '[{"name": "a", "kind": "bed", "size": (256, 256, 256)}, {"name": "b", "kind": "mesh", "a": "tub"}]',
    )
    assert [d["name"] for d in declared] == ["a", "b"]
    assert declared[0]["size"] == [256, 256, 256]


@pytest.mark.parametrize(
    "body, said",
    [
        ("{}", "checks() must return a list"),
        ("[1]", "checks() #1 must be a dict"),
        ('[{"kind": "mesh", "a": "tub"}]', "needs a name"),
        ('[{"name": "x", "kind": "nope"}]', "kind must be one of"),
        (
            '[{"name": "x", "kind": "mesh", "a": "tub"}, {"name": "x", "kind": "mesh", "a": "lid"}]',
            "two checks have this name",
        ),
        ('[{"name": "x", "kind": "mesh", "a": "tab"}]', "names 'tab', which is no part or group"),
        ('[{"name": "x", "kind": "mesh"}]', "mesh needs a, the name of a part or a group"),
        ('[{"name": "x", "kind": "mesh", "a": "tub", "mn": 1}]', "mesh does not take 'mn'"),
        ('[{"name": "x", "kind": "mesh", "a": "tub", "layout": "sky"}]', "no layout 'sky'"),
        ('[{"name": "x", "kind": "clearance", "a": "tub", "b": "lid"}]', "say what is wanted"),
        ('[{"name": "x", "kind": "clearance", "a": "tub", "b": "lid", "min": "1"}]', "min must be a number"),
        ('[{"name": "x", "kind": "clearance", "a": "tub", "b": "lid", "min": 2, "max": 1}]', "min 2 is above max 1"),
        (
            '[{"name": "x", "kind": "clearance", "a": "tub", "b": "lid", "expected": 1}]',
            "expected takes tolerance or percent",
        ),
        ('[{"name": "x", "kind": "clearance", "a": "tub", "b": "lid", "equals": 1, "max": 2}]', "equals stands alone"),
        ('[{"name": "x", "kind": "thin", "a": "tub"}]', "thin needs min"),
        ('[{"name": "x", "kind": "overhang", "a": "tub", "angle": 90}]', "angle is degrees from vertical"),
        ('[{"name": "x", "kind": "bed", "size": [1, 2]}]', "bed needs size"),
        ('[{"name": "x", "kind": "volume", "a": "tub", "min": float("nan")}]', "min must be a number"),
    ],
)
def test_a_malformed_declaration_fails_the_build_with_its_reason(tmp_path, body, said):
    with pytest.raises(LoadError, match=re.escape(said)) as e:
        load(tmp_path, body)
    assert e.value.kind == "exception"


def test_a_clearance_inside_its_band_passes_and_says_it_is_exact(tmp_path):
    got = one(tmp_path, '{"name": "lid fits", "kind": "clearance", "a": "lid", "b": "tub", "min": 0.1, "max": 0.2}')
    assert got["status"] == "pass"
    assert got["value"] == pytest.approx(0.15)
    assert (got["min"], got["max"], got["unit"], got["exact"]) == (0.1, 0.2, "mm", True)
    assert got["layout"] == "assembly" and got["declared"]["name"] == "lid fits"


def test_a_clearance_outside_its_band_fails_and_the_build_still_has_it(tmp_path):
    got = one(tmp_path, '{"name": "lid fits", "kind": "clearance", "a": "lid", "b": "tub", "min": 0.3, "max": 0.4}')
    assert got["status"] == "fail" and got["value"] == pytest.approx(0.15)


def test_a_bound_is_met_to_the_arithmetic_of_the_model(tmp_path):
    edge = one(tmp_path, '{"name": "x", "kind": "clearance", "a": "lid", "b": "tub", "min": 0.15}')
    assert edge["status"] == "pass"
    sums = one(
        tmp_path,
        '{"name": "x", "kind": "clearance", "a": "lid", "b": "tub", '
        '"min": Params().clearance - 0.05, "max": Params().clearance + 0.05}',
    )
    assert sums["status"] == "pass"


def test_expected_with_a_percent_or_a_tolerance(tmp_path):
    ok = one(tmp_path, '{"name": "v", "kind": "volume", "a": "tub", "expected": 4150, "percent": 5}')
    assert ok["status"] == "pass" and ok["value"] == pytest.approx(4000) and ok["unit"] == "mm³"
    assert (ok["min"], ok["max"]) == (pytest.approx(4150 * 0.95), pytest.approx(4150 * 1.05))
    bad = one(tmp_path, '{"name": "v", "kind": "volume", "a": "tub", "expected": 5000, "tolerance": 10}')
    assert bad["status"] == "fail"


def test_overlap_wants_nothing_shared_unless_told(tmp_path):
    assert one(tmp_path, '{"name": "o", "kind": "overlap", "a": "tub", "b": "lid"}')["status"] == "pass"
    got = one(tmp_path, '{"name": "o", "kind": "overlap", "a": "tub", "b": "pad"}')
    assert got["status"] == "fail" and got["value"] == pytest.approx(4 * 4 * 2)
    allowed = one(tmp_path, '{"name": "o", "kind": "overlap", "a": "tub", "b": "pad", "max": 40}')
    assert allowed["status"] == "pass"


def test_solids_counts_the_solids_of_a_part(tmp_path):
    assert one(tmp_path, '{"name": "s", "kind": "solids", "a": "tub", "equals": 1}')["status"] == "pass"
    got = one(tmp_path, '{"name": "s", "kind": "solids", "a": "pair", "equals": 1}')
    assert got["status"] == "fail" and got["value"] == 2


def test_thin_is_never_exact_and_a_pass_says_found_none(tmp_path):
    ok = one(tmp_path, '{"name": "w", "kind": "thin", "a": "tub", "min": 1.2}')
    assert ok["status"] == "pass" and ok["exact"] is False and "none found" in ok["how"]
    assert (ok["min"], ok["max"]) == (1.2, None)
    bad = one(tmp_path, '{"name": "w", "kind": "thin", "a": "tub", "min": 15}')
    assert bad["status"] == "fail" and bad["value"] == pytest.approx(10)


def test_overhang_mesh_and_bed(tmp_path):
    assert one(tmp_path, '{"name": "h", "kind": "overhang", "a": "tub"}')["status"] == "pass"
    got = one(tmp_path, '{"name": "h", "kind": "overhang", "a": "mushroom"}')
    assert got["status"] == "fail" and got["value"] > 0 and got["unit"] == "mm²"
    assert one(tmp_path, '{"name": "m", "kind": "mesh", "a": "tub"}')["status"] == "pass"
    assert one(tmp_path, '{"name": "b", "kind": "bed", "size": [256, 256, 256]}')["status"] == "pass"
    small = one(tmp_path, '{"name": "b", "kind": "bed", "size": [20, 20, 20], "layout": "assembly"}')
    assert small["status"] == "fail" and small["value"] > 0


def test_a_group_stands_for_its_parts(tmp_path):
    clear = one(tmp_path, '{"name": "g", "kind": "clearance", "a": "shell", "b": "pad", "min": 0}')
    assert clear["status"] == "pass" and clear["value"] == 0
    both = one(tmp_path, '{"name": "g", "kind": "volume", "a": "shell", "equals": 8000}')
    assert both["status"] == "pass"
    walls = one(tmp_path, '{"name": "g", "kind": "thin", "a": "shell", "min": 1}')
    assert walls["status"] == "pass"


def test_a_check_that_cannot_be_measured_is_an_error_not_a_failed_build(tmp_path):
    got = one(tmp_path, '{"name": "x", "kind": "clearance", "a": "tub", "b": "tub", "min": 0}')
    assert got["status"] == "error" and "same part" in got["reason"]
    got = one(tmp_path, '{"name": "x", "kind": "mesh", "a": "tub"}')
    assert got["status"] == "pass"


def test_past_the_budget_the_rest_are_not_run(tmp_path):
    got = measured(
        tmp_path,
        '[{"name": "a", "kind": "mesh", "a": "tub"}, {"name": "b", "kind": "mesh", "a": "lid"}]',
        budget=-1,
    )
    assert [g["status"] for g in got] == ["not run", "not run"]
    assert "ran out" in got[0]["reason"]


def test_a_model_without_checks_has_none_in_the_scene():
    assert worker._model_checks([], {}, [], {}) == []


def test_interference_counts_the_pairs_of_a_layout_that_share_volume(tmp_path):
    got = one(tmp_path, '{"name": "no clashes", "kind": "interference"}')
    # The pad pokes into the tub and the lid: two pairs share volume (check interference's own `interfering`).
    assert got["status"] == "fail" and got["value"] == 2 and got["unit"] == "pairs" and got["layout"] == "assembly"
    assert got["min"] is None and got["max"] == 0.0 and got["exact"] is True
    (tmp_path / "m.py").write_text(MODEL.replace("CHECKS", '[{"name": "no clashes", "kind": "interference"}]').replace('        "pad": Pos(10, 0, 0) * Box(4, 4, 4),\n', ""))
    layouts, _, groups, declared = load_model(tmp_path, "m.py")
    _, _, shapes = build_scene(layouts, "m.py", {})
    clear = modelchecks.run(declared, shapes, groups, {})[0]
    assert clear["status"] == "pass" and clear["value"] == 0


def test_interference_takes_no_part_and_a_layout_is_optional(tmp_path):
    with pytest.raises(LoadError, match=re.escape("interference does not take 'a'")):
        load(tmp_path, '[{"name": "x", "kind": "interference", "a": "tub"}]')
    assert load(tmp_path, '[{"name": "x", "kind": "interference", "layout": "assembly"}]')[3][0]["layout"] == "assembly"
