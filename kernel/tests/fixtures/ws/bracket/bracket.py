from dataclasses import dataclass

from build123d import Box, Cylinder, Pos, Rot


@dataclass(frozen=True)
class Params:
    width: float = 40


def assembly(p):
    return {"base": Box(40, 30, 5), "post": Pos(0, 0, 12.5) * Cylinder(4, 20)}


def printables(p):
    parts = assembly(p)
    return {"base": parts["base"], "post": Pos(60, 0, 4) * Rot(90, 0, 0) * Cylinder(4, 20)}


if __name__ == "__main__":
    raise SystemExit("must not run")
