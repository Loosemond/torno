"""Two parts posed on top of each other for the bed, for what a spread layout does to marks.

``width.txt`` holds the width of the first part, in mm. The kernel sets the
parts of the ``print`` layout side by side along X, so a wider ``tray`` pushes
``lid`` further along: by 5 mm when the width goes from 30 to 40.
"""

from dataclasses import dataclass
from pathlib import Path

from build123d import Box, Pos

width = float((Path(__file__).parent / "width.txt").read_text().strip())


@dataclass(frozen=True)
class Params:
    width: float = width


def printables(p):
    # Both stand on the bed at the origin, as each would be printed.
    return {
        "tray": Pos(0, 0, 2) * Box(p.width, 20, 4),
        "lid": Pos(0, 0, 1) * Box(20, 20, 2),
    }
