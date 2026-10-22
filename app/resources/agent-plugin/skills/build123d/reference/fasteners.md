# Screws, nuts and inserts without bd_warehouse

`bd_warehouse` (fasteners, nuts, `ClearanceHole`, `HeatSetNut`) is **not in torno's kernel environment**: a model
that imports it fails the build with `ModuleNotFoundError`. It works only where the object's own workspace has it
(a `pyproject.toml` that lists it, with a `.venv`); if the model must be built by torno elsewhere, do not import it.
Make the hole from the sizes below, each a field of `Params` with the source in a comment.

All sizes are millimetres, for a metric ISO screw. The ISO columns are for the part made in metal; for a part that is
printed (FDM) add an allowance of about 0.1 to 0.3 mm to a pocket (`slack` below) and test one print before the rest.
A thread is not modelled: the hole is the size the screw passes through, or the size a tap or a self-tapping screw
starts from.

## Holes

| Screw | Clearance, fine (close) | Clearance, medium | Clearance, coarse | Tap drill (coarse thread) |
|-------|------|------|------|------|
| M2    | 2.2  | 2.4  | 2.6  | 1.6  |
| M2.5  | 2.7  | 2.9  | 3.1  | 2.05 |
| M3    | 3.2  | 3.4  | 3.6  | 2.5  |
| M4    | 4.3  | 4.5  | 4.8  | 3.3  |
| M5    | 5.3  | 5.5  | 5.8  | 4.2  |
| M6    | 6.4  | 6.6  | 7.0  | 5.0  |
| M8    | 8.4  | 9.0  | 10.0 | 6.8  |

Clearance: ISO 273 (the three series). Tap drill: the minor diameter of the ISO 261 coarse thread, rounded to a standard drill (DIN 336).
Medium is the one to use unless the fit is asked for.

## Heads and nuts

| Screw | Socket head: diameter | height | Countersunk (90 degrees): head diameter | Hex nut: across flats | thickness |
|-------|------|-----|-------|-----|-----|
| M2    | 3.8  | 2.0 | -     | 4.0 | 1.6 |
| M2.5  | 4.5  | 2.5 | -     | 5.0 | 2.0 |
| M3    | 5.5  | 3.0 | 6.72  | 5.5 | 2.4 |
| M4    | 7.0  | 4.0 | 8.96  | 7.0 | 3.2 |
| M5    | 8.5  | 5.0 | 11.2  | 8.0 | 4.7 |
| M6    | 10.0 | 6.0 | 13.44 | 10.0 | 5.2 |
| M8    | 13.0 | 8.0 | 17.92 | 13.0 | 6.8 |

Socket head cap screw: ISO 4762 (maximum head diameter and head height). Countersunk: ISO 10642 (theoretical head
diameter). Hex nut: ISO 4032 (across flats, maximum thickness). A counterbore is the head diameter plus the
allowance, as deep as the head is high plus the allowance; a nut pocket is a hexagon of circumradius
`(across flats + allowance) / sqrt(3)`.

## Heat-set inserts

There is no standard: the hole is the one the insert's maker gives, and it differs between makers. Typical values
for the short brass inserts sold for 3D printing (hole in the printed part, for an insert pressed in with a
soldering iron) are in the table; read the datasheet of the insert that will be bought and say which in a comment.

| Insert | Hole diameter | Depth (insert length plus about 1 mm) |
|--------|------|------|
| M2     | 3.2  | 4.0 to 5.0 |
| M2.5   | 3.6  | 5.0 to 6.0 |
| M3     | 4.0  | 6.0 to 7.0 |
| M4     | 5.6  | 7.0 to 8.0 |
| M5     | 6.4  | 8.0 to 9.0 |

(Source: the hole sizes CNC Kitchen publishes for its inserts, https://www.cnckitchen.com; they are typical, not
a standard. Check them against the insert bought.)

## A screw hole with a head pocket and a nut pocket

```python
import math
from dataclasses import dataclass

from build123d import Box, Cylinder, Pos, RegularPolygon, extrude


@dataclass
class Params:
    thickness: float = 8.0
    screw_hole: float = 3.4   # M3 clearance, medium: ISO 273
    head_d: float = 5.5       # M3 socket head cap: ISO 4762
    head_h: float = 3.0
    nut_af: float = 5.5       # M3 hex nut across flats: ISO 4032
    nut_h: float = 2.4
    slack: float = 0.2        # printed pockets: tune on the printer


def make_plate(p: Params):
    plate = Box(30, 20, p.thickness)
    top = p.thickness / 2
    hole = Cylinder(p.screw_hole / 2, p.thickness + 1)
    # centred on the top face and twice as deep: it overshoots the face, so the cut is clean
    head = Pos(0, 0, top) * Cylinder((p.head_d + 2 * p.slack) / 2, 2 * (p.head_h + p.slack))
    # a hexagon whose corners are on X; it starts at the bottom face and goes up
    nut = Pos(0, 0, -top - 0.01) * extrude(
        RegularPolygon(radius=(p.nut_af + 2 * p.slack) / math.sqrt(3), side_count=6), amount=p.nut_h + p.slack + 0.01
    )
    return plate - hole - head - nut


part = make_plate(Params())
assert part.is_valid and len(part.solids()) == 1
assert part.volume < Box(30, 20, 8).volume - Cylinder(1.7, 8).volume
```
