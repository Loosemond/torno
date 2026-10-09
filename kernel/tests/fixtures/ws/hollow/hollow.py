"""A box with nothing in it, for looking inside: what a section is for.

A tub 40 × 40 × 38 mm with 2 mm walls and a 2 mm floor, standing on z = 0, and
a lid 2 mm thick that closes it, so the cavity (36 × 36 × 36 mm) cannot be
seen from outside. A post Ø6 stands on the floor inside, 20 mm tall.
"""

from dataclasses import dataclass

from build123d import Box, Cylinder, Pos


@dataclass(frozen=True)
class Params:
    side: float = 40
    wall: float = 2


def assembly(p):
    inner = p.side - 2 * p.wall
    height = p.side - p.wall
    tub = Pos(0, 0, height / 2) * Box(p.side, p.side, height)
    tub -= Pos(0, 0, p.wall + inner / 2) * Box(inner, inner, inner)
    tub += Pos(0, 0, p.wall + 10) * Cylinder(3, 20)
    lid = Pos(0, 0, height + p.wall / 2) * Box(p.side, p.side, p.wall)
    return {"tub": tub, "lid": lid}
