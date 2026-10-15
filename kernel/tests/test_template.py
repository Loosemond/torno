import time
from pathlib import Path

import build123d  # noqa: F401  (imported once by the worker long before a model loads: not part of the time)
import pytest

from torno_kernel.loader import choose_model, load_scene

# The one source of torno's template: app/src/main/objects/template.py.txt, which main writes into a new object.
TEMPLATE = Path(__file__).parents[2] / "app" / "src" / "main" / "objects" / "template.py.txt"


def test_template_builds_through_the_loader_as_one_placeholder_part(tmp_path):
    (tmp_path / "cable_clip.py").write_text(TEMPLATE.read_text())
    assert choose_model(tmp_path).name == "cable_clip.py"
    started = time.monotonic()
    scene = load_scene(tmp_path, "cable_clip.py")
    assert time.monotonic() - started < 1.0
    assert list(scene) == ["assembly"]
    assert list(scene["assembly"]) == ["placeholder"]
    cube = scene["assembly"]["placeholder"]
    box = cube.bounding_box()
    assert (box.size.X, box.size.Y, box.size.Z) == pytest.approx((20, 20, 20))
    # Filleted by 1 mm: less than a sharp cube, more than a ball.
    assert 0.98 * 8000 < cube.volume < 8000
