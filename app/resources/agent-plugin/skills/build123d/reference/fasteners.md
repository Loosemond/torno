# Screws, nuts and inserts

`bd_warehouse` (fasteners, nuts, `ClearanceHole`, `InsertHole`, bearings) is in torno's kernel environment, in any
workspace, with or without a `pyproject.toml` of its own: `from bd_warehouse.fastener import ...` works. Use it
rather than work out a head or a tap diameter by hand. Where the workspace has its own `.venv`, it has `bd_warehouse`
only if its `pyproject.toml` lists it. The tables further down are the sizes to put in `Params` when a model should
not depend on the library, and the ones to check what it gives.

## With bd_warehouse

A fastener is a part to **look at and check against**, not one to print: put it among `references(p)`
(see the `torno-model` skill), never among `assembly(p)` or `printables(p)`, or torno would print it, count it in
`bed` and give it a mass. Pass `simple=True`: a screw without its thread is one solid, light to draw and exact enough
to check a clearance.

- `SocketHeadCapScrew(size="M3-0.5", length=10, fastener_type="iso4762", simple=True)`, `CounterSunkScrew`,
  `ButtonHeadScrew`, `HexNut(size="M3-0.5", fastener_type="iso4032", simple=True)`: `size` is `M<d>-<pitch>`;
  an unknown one raises `ValueError` listing the sizes there are. `.types()` on a class lists the standards.
- The origin of a screw is under its head, its axis is +Z and its shank goes down (-Z): `Pos(x, y, z) * screw`
  puts its head on the face at `z`, shank into the part; turn it with `Rot` or `Plane`.
- `ClearanceHole(fastener=screw, fit="Normal", depth=..., counter_sunk=...)` and `InsertHole(fastener=insert, ...)`
  cut the hole for the fastener in a `BuildPart`, at each location. `fit` is `Close`, `Normal` or `Loose`. `InsertHole` takes a
  `HeatSetNut(size="M3-0.5-Standard", fastener_type="McMaster-Carr", simple=True)`; the makers
  (`HeatSetNut.types()`) differ in their holes, so name the one that will be bought.
- Bearings: `from bd_warehouse.bearing import SingleRowDeepGrooveBallBearing`;
  `SingleRowDeepGrooveBallBearing(size="M8-22-7", bearing_type="SKT")` is a 608 (8 mm bore, 22 mm outer, 7 mm wide),
  `.sizes("SKT")` lists the others. It is a compound of many solids; torno takes a reference as one shape.
- Make the fastener **before** the `with BuildPart()`: one made inside a builder is added to the part, and the
  part then has the screw in it.
- What a library gives is the standard's size: the allowance of a printed part is still the part's (`slack`).

```python
from dataclasses import dataclass

from bd_warehouse.bearing import SingleRowDeepGrooveBallBearing
from bd_warehouse.fastener import ClearanceHole, SocketHeadCapScrew
from build123d import Box, BuildPart, Locations, Pos


@dataclass
class Params:
    length: float = 10.0  # M3 screw, ISO 4762


def screw(p: Params):
    return SocketHeadCapScrew(size="M3-0.5", length=p.length, fastener_type="iso4762", simple=True)


def make_block(p: Params):
    bolt = screw(p)  # made before the builder: one made inside a BuildPart is added to the part
    with BuildPart() as block:
        Box(30, 20, 8)
        with Locations((0, 0, 4)):
            ClearanceHole(fastener=bolt, fit="Normal", depth=8, counter_sunk=False)
    return block.part


def references(p: Params):
    # bought: drawn and checked against, never printed
    return {"screw": Pos(0, 0, 4) * screw(p), "bearing": Pos(25, 0, 0) * SingleRowDeepGrooveBallBearing(size="M8-22-7", bearing_type="SKT")}


block = make_block(Params())
assert block.is_valid and len(block.solids()) == 1 and block.volume < 30 * 20 * 8
assert set(references(Params())) == {"screw", "bearing"}
```

## Without it: sizes for `Params`

All sizes are millimetres, for a metric ISO screw. The ISO columns are for the part made in metal. For a part that is
printed (FDM) a pocket usually wants an allowance on top (`slack` below, 0.2 mm in the example): this is a practice
and an assumption, no standard and no source, to be tuned on the printer; print one test piece before the rest.
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

**Assumed, with no source: these numbers are from memory and were not checked against any document.** There is no
standard: the hole is the one the maker of the insert gives, and it differs between makers. Replace the table with the
datasheet of the insert that will be bought, and say which in a comment; until then ask the person, or build the
part with the guessed value as a field of `Params` named so (`insert_hole_assumed`).

| Insert | Hole diameter (assumed) |
|--------|------|
| M2     | 3.2  |
| M2.5   | 3.6  |
| M3     | 4.0  |
| M4     | 5.6  |
| M5     | 6.4  |

The depth of the blind hole is the insert's length plus some room for the melted plastic it pushes down; how much
is the maker's to say (also not sourced here).

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
    slack: float = 0.2        # assumed, not a standard: tune on the printer


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
