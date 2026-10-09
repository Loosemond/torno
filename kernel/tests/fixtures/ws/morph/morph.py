"""A part that changes shape with the file beside it, for what must survive a rebuild.

``variant.txt`` holds ``a`` or ``b``. ``a`` is a 40 × 30 × 5 plate with a post
standing on it. ``b`` is the same plate 8 mm thick, grown upwards, its top
edges chamfered (so its faces are numbered otherwise), and no post.
"""

from pathlib import Path

from build123d import Axis, Box, Cylinder, Pos, chamfer

variant = (Path(__file__).parent / "variant.txt").read_text().strip()

if variant == "a":
    plate = Box(40, 30, 5)
    post = Pos(0, 0, 12.5) * Cylinder(4, 20)
elif variant == "b":
    # The underside stays at z = -2.5; the top moves from 2.5 to 5.5.
    _block = Pos(0, 0, 1.5) * Box(40, 30, 8)
    plate = chamfer(_block.edges().group_by(Axis.Z)[-1], 1)
else:
    raise ValueError(f"variant.txt says {variant!r}; it must say a or b")
