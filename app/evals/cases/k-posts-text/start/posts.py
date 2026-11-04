from dataclasses import dataclass

from build123d import Box, Cylinder, Pos


@dataclass(frozen=True)
class Params:
    height: float = 20.0


def assembly(p):
    return {
        "base": Box(80, 30, 5),
        "left": Pos(-25, 0, 2.5 + p.height / 2) * Cylinder(5, p.height),
        "right": Pos(25, 0, 2.5 + p.height / 2) * Cylinder(5, p.height),
    }
