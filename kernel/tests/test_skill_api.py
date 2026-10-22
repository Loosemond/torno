"""The build123d skill (app/resources/agent-plugin/skills/build123d): its offline API reference is the pinned
build123d's own, and every example in it builds.

    TORNO_API=write uv run --no-sync pytest -q tests/test_skill_api.py   # writes the reference anew (or: python scripts/build123d_api.py)
"""

import importlib.util
import os
import re
from pathlib import Path

import build123d
import pytest

KERNEL = Path(__file__).parents[1]
SKILL_DIR = KERNEL.parent / "app" / "resources" / "agent-plugin" / "skills" / "build123d"
SKILL = SKILL_DIR / "SKILL.md"
REFERENCE = SKILL_DIR / "reference"
PIN = re.search(r'"build123d==([^"]+)"', (KERNEL / "pyproject.toml").read_text()).group(1)

# The most the plugin may carry for the reference, which ships in every copy of the app and is grepped by the agent.
MAX_REFERENCE_BYTES = 150_000


def _generator():
    spec = importlib.util.spec_from_file_location("build123d_api", KERNEL / "scripts" / "build123d_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_pinned_build123d_is_the_one_installed():
    assert build123d.__version__ == PIN


def test_the_reference_is_of_the_pinned_version_and_of_none_other():
    # A pin moved in pyproject.toml without the reference made again leaves api-<old>.txt here, or none.
    files = sorted(p.name for p in REFERENCE.glob("api-*.txt"))
    assert files == [f"api-{PIN}.txt"], f"regenerate: cd kernel && uv run --no-sync python scripts/build123d_api.py ({files})"


def test_the_reference_is_the_installed_build123d_as_it_is_now():
    generator = _generator()
    text = generator.render()
    path = generator.reference_path()
    if os.environ.get("TORNO_API") == "write":
        generator.main([])
    assert path.is_file() and path.read_text() == text, (
        "the reference is stale: cd kernel && uv run --no-sync python scripts/build123d_api.py"
    )
    # What a grep is for: a function, a class with its signature, a method of a base class, a member of an enum.
    assert re.search(r"^def fillet\(objects", text, re.M)
    assert re.search(r"^class Cylinder\(", text, re.M) and "Cylinder(radius" in text
    assert "Mixin3D.max_fillet(" in text and "Shape.moved(" in text
    assert re.search(r"^class Align\(Enum\)", text, re.M) and "members: MIN, CENTER, MAX" in text


def test_the_reference_has_a_size_a_packaged_app_can_carry():
    size = (REFERENCE / f"api-{PIN}.txt").stat().st_size
    assert 40_000 < size < MAX_REFERENCE_BYTES, size


def test_the_reference_text_is_the_same_each_time_it_is_made():
    generator = _generator()
    assert generator.render() == generator.render()


def test_the_skill_names_its_reference_files_and_stays_short():
    text = SKILL.read_text()
    assert f"${{CLAUDE_SKILL_DIR}}/reference/api-{PIN}.txt" in text
    for name in re.findall(r"\$\{CLAUDE_SKILL_DIR\}/(reference/[\w.-]+)", text):
        assert (SKILL_DIR / name).is_file(), name
    assert len(text.splitlines()) < 500
    head = text.split("---")[1]
    fields = dict(re.findall(r"^(\w+): (.*)$", head, re.M))
    assert set(fields) == {"name", "description", "when_to_use"}
    # Claude Code cuts the listing of a skill at 1,536 characters of both together.
    assert len(fields["description"]) + len(fields["when_to_use"]) < 1536


def _examples() -> list:
    found = []
    for path in (SKILL, REFERENCE / "fasteners.md"):
        for n, code in enumerate(re.findall(r"```python\n(.*?)```", path.read_text(), re.S), 1):
            found.append(pytest.param(code, id=f"{path.name}-{n}"))
    return found


@pytest.mark.parametrize("code", _examples())
def test_every_example_runs_on_the_pinned_build123d(code):
    # Each one checks itself with asserts, and none relies on another: they are run apart.
    exec(compile("from build123d import *\n" + code, "<skill example>", "exec"), {"__name__": "skill_example"})


def test_the_skill_has_examples():
    assert len(_examples()) >= 8
