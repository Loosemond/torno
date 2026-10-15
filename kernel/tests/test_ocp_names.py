"""What the kernel takes from ocp-tessellate, held to what every version it may meet has.

The kernel is started in a workspace with a ``pyproject.toml`` as ``uv run --no-sync --project <workspace>
--with-editable <kernel>`` (``app/src/main/kernel/client.ts``): ocp-tessellate comes in with the kernel, resolved
afresh within ``>=3.5,<4`` beside the workspace's own OCP, while these tests run with the version this
repository locks. ocp-tessellate 3.6 no longer hands on OCP's own names from ``ocp_utils`` (``Bnd_Box``,
``BRepGProp``, ``TopTools_IndexedMapOfShape``, …): taken from there they failed in a workspace with OCP 8.0.1.1
and ocp-tessellate 3.6.2 while every test here passed. So OCP's names are taken from OCP (``torno_kernel.ocp``
for those OCP 8 moved), and from ocp-tessellate only what is its own, named here and found in 3.5.3 and 3.6.2.
"""

import ast
from pathlib import Path

SOURCES = Path(__file__).resolve().parents[1] / "src" / "torno_kernel"

# Its own functions, which both 3.5.3 and 3.6.2 have.
OWN = {
    "ocp_tessellate.convert": {"to_ocpgroup", "tessellate_group"},
    "ocp_tessellate.ocp_utils": {"bounding_box"},
    "ocp_tessellate.tessellator": {"compute_quality"},
}


def _taken() -> dict[str, set[str]]:
    taken: dict[str, set[str]] = {}
    for path in sorted(SOURCES.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), str(path))):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("ocp_tessellate"):
                taken.setdefault(node.module, set()).update(alias.name for alias in node.names)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith("ocp_tessellate") and alias.name not in OWN:
                        taken.setdefault(alias.name, set()).add("*")
    return taken


def test_the_kernel_takes_from_ocp_tessellate_only_its_own_functions():
    taken = _taken()
    assert set(taken) <= set(OWN), taken
    for module, names in taken.items():
        assert names <= OWN[module], (module, names - OWN[module])


def test_those_functions_are_there():
    import importlib

    for module, names in OWN.items():
        loaded = importlib.import_module(module)
        for name in names:
            assert callable(getattr(loaded, name)), (module, name)
