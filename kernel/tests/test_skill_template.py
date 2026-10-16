import re
from pathlib import Path

import pytest

from torno_kernel.loader import choose_model, load_scene

# The template the torno-model skill gives Claude Code (app/resources/agent-plugin): it must build as it says.
SKILL = Path(__file__).parents[2] / "app" / "resources" / "agent-plugin" / "skills" / "torno-model" / "SKILL.md"


def test_the_skill_template_builds_both_layouts_through_the_loader(tmp_path):
    code = re.search(r"```python\n(.*?)```", SKILL.read_text(), re.S).group(1)
    (tmp_path / "box_lid.py").write_text(code)
    scene = load_scene(tmp_path, choose_model(tmp_path).name)
    assert list(scene) == ["assembly", "print"]
    assert list(scene["assembly"]) == ["tub", "lid"] == list(scene["print"])
    tub, lid = scene["assembly"]["tub"].bounding_box(), scene["assembly"]["lid"].bounding_box()
    assert (tub.size.X, tub.size.Y, tub.size.Z) == pytest.approx((60, 40, 30))
    # The lid sits on the tub: its plate on the rim, its lip inside.
    assert lid.max.Z == pytest.approx(tub.max.Z + 2)
    assert lid.min.Z < tub.max.Z
