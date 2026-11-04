"""A housing for a 608 bearing, with the bearing as a reference: bought, drawn and checked against, never printed."""

from dataclasses import dataclass

from bd_warehouse.bearing import SingleRowDeepGrooveBallBearing
from build123d import Box, Cylinder, Pos


@dataclass(frozen=True)
class Params:
    bore: float = 22.2  # mm, the seat for the outer ring (22 mm)


def _housing(p: Params):
    return Box(40, 40, 7) - Cylinder(p.bore / 2, 7)


def assembly(p: Params):
    return {"housing": _housing(p), "cap": Pos(0, 0, 10) * Box(40, 40, 3)}


def printables(p: Params):
    return {"housing": _housing(p), "cap": Box(40, 40, 3)}


def references(p: Params):
    return {"608": SingleRowDeepGrooveBallBearing(size="M8-22-7", bearing_type="SKT")}


def checks(p: Params):
    return [{"name": "bearing seat", "kind": "clearance", "a": "housing", "b": "608", "min": 0.05, "max": 0.3}]
