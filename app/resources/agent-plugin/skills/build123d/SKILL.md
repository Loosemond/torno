---
name: build123d
description: Idioms of build123d 0.13 (algebra and builder mode, locations and planes, selectors, fillets and chamfers, booleans) and the usual OCCT failures. Use when writing or repairing a build123d model, or when a build fails in a fillet, a chamfer or a boolean.
---

# build123d in torno

torno's kernel is pinned to **build123d 0.13.0**; a workspace with its own `pyproject.toml` may have another.
When unsure of a signature, read the installed version's own documentation, offline. This does not run the
model, so it is allowed:

```sh
uv run --no-sync python -c "import build123d; help(build123d.fillet)"
uv run --no-sync python -c "import build123d; print(build123d.__version__)"
```

(`--no-sync`, and only where the workspace has a `.venv`: never `uv sync` or a plain `uv run` there.)

## Two modes

**Algebra mode**: shapes are values, combined with operators. Prefer it in a torno model: each `make_<part>`
returns a value.

```python
plate = Box(40, 30, 5)
plate -= Pos(10, 0, 0) * Cylinder(3, 5)              # subtract
plate = fillet(plate.edges().filter_by(Axis.Z), 2)   # operations return a new shape
boss = extrude(Plane.XY.offset(2.5) * Circle(4), amount=6)
part = plate + Pos(-10, 0, 0) * boss                 # add; & intersects
```

**Builder mode**: a `with BuildPart() as bp:` block in which each object is added to the part (`mode=Mode.SUBTRACT`
to cut), sketches are made on faces with `BuildSketch`, and `bp.part` is the result.

```python
with BuildPart() as bp:
    Box(40, 30, 5)
    with Locations(bp.faces().sort_by(Axis.Z)[-1]):
        with GridLocations(20, 10, 2, 2):
            Hole(2)
    fillet(bp.edges().filter_by(Axis.Z), 2)
    with BuildSketch(bp.faces().sort_by(Axis.Z)[-1]):
        Circle(4)
    extrude(amount=6)
    fillet(bp.edges(Select.LAST).group_by(Axis.Z)[-1], 1)
part = bp.part
```

Do not mix them in one expression: an algebra shape made inside a builder is added to it.

## Locations and planes

- `Pos(x, y, z) * shape` moves, `Rot(x, y, z) * shape` turns (degrees, about X, then Y, then Z),
  `Location((x, y, z), (rx, ry, rz))` both; `shape.moved(loc)` too. They compose left to right as written:
  `Pos(...) * Rot(...) * shape` turns, then moves.
- Primitives are centred on their location by default (`Box(10, 10, 2)` spans z -1 to 1); `align=(Align.MIN,
  Align.MIN, Align.MIN)` puts a corner there instead.
- `Plane.XY`, `Plane.XZ`, `Plane.YZ`, `Plane.XY.offset(z)`, `Plane(face)`: `plane * Circle(4)` puts a sketch on
  it; `extrude(sketch, amount=…)` extrudes along its normal.
- `GridLocations(dx, dy, nx, ny)`, `PolarLocations(r, n)`, `Locations(...)`: in algebra mode
  `[loc * Cylinder(1, 10) for loc in GridLocations(10, 10, 2, 2)]`.

## Selectors

- `shape.faces()`, `.edges()`, `.vertices()`, `.solids()` give a `ShapeList`.
- `.sort_by(Axis.Z)[-1]`: the topmost; `[0]` the lowest. `.sort_by(SortBy.AREA)`, `SortBy.LENGTH`, `SortBy.RADIUS`.
- `.filter_by(Axis.Z)`: edges along Z, or faces whose normal is along Z; `.filter_by(GeomType.CIRCLE)`.
- `.group_by(Axis.Z)[-1]`: everything at the highest Z, as one list.
- In builder mode `bp.edges(Select.LAST)` is what the last operation made.

Prefer selecting by position and kind over a face's number: torno's refs (`lid/F12`) are renumbered on every
build and must never be written into the model.

## Fillets and chamfers

- `fillet(edges, radius)`, `chamfer(edges, length)`. The radius must be under the wall and under half the
  shortest adjacent edge: a radius at or above the wall fails (`ValueError: Failed creating a fillet with radius
  of 1.5, try a smaller value or use max_fillet()`). `shape.max_fillet(edges)` gives the largest that works.
- Order matters: make all the solid geometry first (bosses, cuts, holes), then fillet; fillet the larger radii
  before the smaller, and vertical edges before the ones round the top. A fillet that meets another fillet's edge
  often fails: select edges from the shape just before.
- A fillet that fails after a boolean usually means the selection includes tiny edges the boolean left: narrow it
  (`filter_by`, `group_by`) or fillet before the boolean.

## Booleans

- `StdFail_NotDone`, `BRep_API: command not done` or an empty result: the two shapes touch only along a face or an
  edge, or are coincident. Make a cutting tool overshoot what it cuts (a hole 0.01 mm or more longer each way) and
  a join overlap by a little rather than meet exactly.
- A union of shapes that do not touch is several solids: torno takes each part as it is, and the build result of an
  edit says so under `Check:` (`plate is 2 solids (was 1)`), with every part that is not valid, inside out or open.
- Many small cuts are faster as one: build the tools as a list and subtract their sum, or use `Hole` in builder mode.
- Thin walls under about 0.01 mm and self-intersecting sketches give invalid solids: `check` with `kind: "mesh"`
  says whether the part's mesh is closed.

## Text and threads

`Text("A", font_size=5)` is a sketch, to extrude or cut. Real threads are slow to build and heavy to draw: model
a printed thread only when it is asked for, and keep its `Params` (pitch, length) explicit.
