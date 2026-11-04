from dataclasses import dataclass

from build123d import Box, Pos


@dataclass(frozen=True)
class Params:
    wall: float = 2.0


def assembly(p):
    tub = Box(70, 50, 30) - Pos(0, 0, p.wall) * Box(70 - 2 * p.wall, 50 - 2 * p.wall, 30)
    lid = Pos(0, 0, 15 + 1) * Box(70, 50, 2)
    return {"tub": tub, "lid": lid}
