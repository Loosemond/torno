"""`app/evals/score.py`: the checks of an eval case, on the B-rep of a known model, through torno's loader."""

import importlib.util
import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

SCORE = Path(__file__).resolve().parents[2] / "app" / "evals" / "score.py"
spec = importlib.util.spec_from_file_location("eval_score", SCORE)
score_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score_module)
score = score_module.score

# A plate 40 x 30 x 6 with a through hole of 5 and a blind hole of 3 (2 deep), and a lid 1 mm above it.
PLATE = """
from dataclasses import dataclass
from build123d import Box, Cylinder, Pos

@dataclass
class Params:
    pass

def assembly(p):
    plate = Box(40, 30, 6) - Pos(10, 0, 0) * Cylinder(2.5, 6) - Pos(-10, 0, 2) * Cylinder(1.5, 2)
    lid = Pos(0, 0, 3 + 1 + 1) * Box(40, 30, 2)
    return {"plate": plate, "lid": lid}
"""


@pytest.fixture
def plate(tmp_path: Path) -> Path:
    folder = tmp_path / "plate"
    folder.mkdir()
    (folder / "plate.py").write_text(PLATE)
    return folder


def by_id(result):
    return {c["id"]: c for c in result["checks"]}


def test_every_kind_on_a_known_model(plate: Path):
    hole = math.pi * 2.5**2 * 6 + math.pi * 1.5**2 * 2
    checks = [
        {"id": "valid", "kind": "valid"},
        {"id": "names", "kind": "parts", "names": ["lid", "plate"]},
        {"id": "count", "kind": "parts", "count": 3},
        {"id": "solids", "kind": "solids", "part": "plate", "count": 1},
        {"id": "x", "kind": "size", "part": "plate", "axis": "x", "expect": 40, "tol": 0.1},
        {"id": "z", "kind": "size", "part": "plate", "axis": "z", "expect": 5, "tol": 0.1},
        {"id": "ratio", "kind": "ratio", "part": "plate", "axis": "x", "over": "y", "expect": 40 / 30, "tol": 0.01},
        {"id": "volume", "kind": "volume", "part": "plate", "min": 40 * 30 * 6 - hole - 1, "max": 40 * 30 * 6 - hole + 1},
        {"id": "gap", "kind": "clearance", "a": "plate", "b": "lid", "min": 0.9, "max": 1.1},
        {"id": "gap-too-small", "kind": "clearance", "a": "plate", "b": "lid", "min": 2},
        {"id": "apart", "kind": "overlap", "a": "plate", "b": "lid"},
        {"id": "through", "kind": "hole", "part": "plate", "diameter": 5, "through": True},
        {"id": "blind", "kind": "hole", "part": "plate", "diameter": 3, "through": False},
        {"id": "not-through", "kind": "hole", "part": "plate", "diameter": 3, "through": True},
        {"id": "here", "kind": "hole", "part": "plate", "diameter": 5, "near": [10, 0, 50]},
        {"id": "not-here", "kind": "hole", "part": "plate", "diameter": 5, "near": [-10, 0, 0]},
        {"id": "missing", "kind": "size", "part": "base", "axis": "x", "expect": 1},
    ]
    result = score(plate, checks)
    assert result["build"] == {"ok": True}
    got = by_id(result)
    passing = {"valid", "names", "solids", "x", "ratio", "volume", "gap", "apart", "through", "blind", "here"}
    assert {k for k, c in got.items() if c["pass"]} == passing
    assert got["count"]["value"] == 2
    assert got["z"]["value"] == pytest.approx(6, abs=1e-3)
    assert got["gap"]["value"] == pytest.approx(1, abs=1e-6)
    assert "no part 'base'" in got["missing"]["error"]


def test_exact_only_where_the_number_is_the_breps(plate: Path):
    got = by_id(score(plate, [
        {"id": "size", "kind": "size", "part": "plate", "axis": "x", "expect": 40},
        {"id": "ratio", "kind": "ratio", "part": "plate", "axis": "x", "over": "y", "expect": 1},
        {"id": "volume", "kind": "volume", "part": "plate", "min": 0},
        {"id": "gap", "kind": "clearance", "a": "plate", "b": "lid"},
    ]))
    # Planes and cylinders: the kernel says the box and the volume are exact.
    assert got["size"]["exact"] is True and got["ratio"]["exact"] is True
    assert got["volume"]["exact"] is True and got["gap"]["exact"] is True


def test_a_freeform_part_is_not_exact(tmp_path: Path):
    folder = tmp_path / "blob"
    folder.mkdir()
    (folder / "blob.py").write_text(
        "from dataclasses import dataclass\n"
        "from build123d import Edge, Vector, Wire, Face, extrude\n"
        "@dataclass\n"
        "class Params:\n"
        "    pass\n"
        "def assembly(p):\n"
        "    e = Edge.make_spline([Vector(*q) for q in [(20, 0), (0, 12), (-15, -2), (8, -9)]], periodic=True)\n"
        "    return {'blob': extrude(Face(Wire([e])), 5)}\n"
    )
    got = by_id(score(folder, [
        {"id": "size", "kind": "size", "part": "blob", "axis": "z", "expect": 5, "tol": 0.01},
        {"id": "volume", "kind": "volume", "part": "blob", "min": 0},
    ]))
    assert got["size"]["exact"] is False and got["volume"]["exact"] is False
    assert got["size"]["pass"] and got["volume"]["pass"]


def test_the_fixture_bracket(ws: Path):
    got = by_id(score(ws / "bracket", [
        {"id": "names", "kind": "parts", "names": ["base", "post"]},
        {"id": "base", "kind": "volume", "part": "base", "min": 5999, "max": 6001},
        {"id": "printed", "kind": "parts", "layout": "print", "count": 2},
    ]))
    assert all(c["pass"] for c in got.values()), got


def test_a_model_that_does_not_load_fails_every_check_and_the_build(ws: Path):
    result = score(ws / "broken", [{"id": "v", "kind": "valid"}])
    assert result["build"]["ok"] is False and result["build"]["error"]
    assert result["checks"] == [{"id": "v", "kind": "valid", "pass": False, "error": "no build"}]


def test_the_command_prints_one_json_line(plate: Path, tmp_path: Path):
    checks = tmp_path / "checks.json"
    checks.write_text(json.dumps([{"id": "v", "kind": "valid"}]))
    out = subprocess.run([sys.executable, str(SCORE), str(plate), str(checks)], capture_output=True, text=True, check=True)
    assert json.loads(out.stdout)["checks"][0]["pass"] is True
