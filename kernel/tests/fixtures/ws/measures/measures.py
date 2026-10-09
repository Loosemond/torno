"""A plate with one of each thing a measurement is asked of.

40 × 30 × 6 mm, centred on the origin: two Ø8 through holes 20 mm apart, a
45° chamfer of 2 mm on the top edge at +X, and a 10 × 6 mm pocket 4 mm deep
that leaves a 2 mm wall to the -Y side and a 2 mm floor.
"""

from dataclasses import dataclass

from build123d import Axis, Box, Cylinder, Pos, chamfer


@dataclass(frozen=True)
class Params:
    hole_spacing: float = 20
    wall: float = 2


def assembly(p):
    plate = Box(40, 30, 6)
    edge = plate.edges().filter_by(Axis.Y).group_by(Axis.Z)[-1].sort_by(Axis.X)[-1]
    plate = chamfer(edge, 2)
    for x in (-p.hole_spacing / 2, p.hole_spacing / 2):
        plate -= Pos(x, 5, 0) * Cylinder(4, 6)
    # From y = -15 + wall to 6 mm further in, from 2 mm above the bottom up through the top.
    plate -= Pos(0, -15 + p.wall + 3, 1) * Box(10, 6, 4)
    return {"plate": plate}
