"""A plate whose thickness and hole are what the file beside it says, for dimensions that are checked on every build.

``variant.txt`` holds ``a`` or ``b``. ``a`` is a 40 × 30 × 6 plate standing on
z = 0, with one Ø8 through hole at (10, 0). ``b`` is the same plate 5 mm
thick, its top 1 mm lower, and the hole Ø9.
"""

from pathlib import Path

from build123d import Box, Cylinder, Pos

variant = (Path(__file__).parent / "variant.txt").read_text().strip()

if variant == "a":
    thickness, hole = 6, 8
elif variant == "b":
    thickness, hole = 5, 9
else:
    raise ValueError(f"variant.txt says {variant!r}; it must say a or b")

plate = Pos(0, 0, thickness / 2) * Box(40, 30, thickness) - Pos(10, 0, thickness / 2) * Cylinder(hole / 2, thickness)
