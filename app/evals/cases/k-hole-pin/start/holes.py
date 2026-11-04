from dataclasses import dataclass

from build123d import Box, Cylinder, Pos


@dataclass(frozen=True)
class Params:
    hole: float = 5.0


def assembly(p):
    plate = Box(90, 40, 6)
    for x in (-30, 0, 30):
        plate -= Pos(x, 0, 0) * Cylinder(p.hole / 2, 6)
    return {"plate": plate}
