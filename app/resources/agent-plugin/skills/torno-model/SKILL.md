---
name: torno-model
description: The contract of a torno model file (Params, assembly, printables, make_<part>) with a template. Use before writing a new model, restructuring one, or when a build fails with no_scene or no_model.
---

# The torno model file

torno imports the model file of the project folder and rebuilds it on every save. Do not run it yourself to
preview it: check the build with `mcp__torno__scene` and look with `mcp__torno__look`.

## Before the first model

Before the first build of a new project, and before a new feature whose key size is not given, settle the sizes:

1. List the sizes that decide fit or function: overall size, wall, the sizes of the parts it mates with, hole and
   fastener sizes, clearances. For each, say where it comes from: `brief.md`, a reference picture's note, a scan
   (≈, to a few mm), another project, or nowhere.
2. For those from nowhere, ask in one round, before you build, with `AskUserQuestion`: at most 4 questions, each with
   2 to 4 options, one of them a typical value labelled as typical ("0.2 mm per side, usual for PLA at a 0.4 mm
   nozzle"); the person may answer "build with assumptions". Do not ask about what you can choose freely (a fillet
   radius, a chamfer). If every size has a source, ask nothing. Never ask more than one round for a change.
3. Build with the answers. A size still unknown is built as assumed: a field of `Params` commented "assumed", and your
   reply lists the assumptions.

## Seeing a value while building

You cannot run the model, but torno gives back what it prints. To see a value, `print()` it in the model (or
`assert` it: a failed assert fails the build and comes back with its traceback). The last 15 lines of what the build
printed come with the answer to your edit, and in `output` of `mcp__torno__scene`, whether the build worked or failed;
build123d's own warnings are among them. Remove the `print` once it has served.

## A CLAUDE.md that names another way to see the build

Claude Code also reads the `CLAUDE.md` files of the workspace and of the person; torno's first prompt of a session
lists them. What torno's tools say of the build is current: a file that names another viewer, report or export step
is about another way of working. Follow its advice on how to model, not on how to see the build, which is
`mcp__torno__scene`, `mcp__torno__look` and `mcp__torno__measure`.

## Which file

- The project folder holds one model file: a top-level `*.py` that is not a test (`test_*.py`, `*_test.py`,
  `conftest.py`), not a dotfile and not `__init__.py`.
- If there are several, the model is the one named after the folder, `-` and `_` counting as the same
  (`helmet-stand/helmet_stand.py`). Otherwise the build fails with `no_model` or as ambiguous.
- Scratch scripts go outside the project folder or in a `tools/` subfolder of it, so the folder keeps one model
  file. Never write in `.torno/`: it is torno's own.

## What torno takes from it

The file is imported as a module (its `if __name__ == "__main__":` block does not run). The first convention it
follows is used:

1. **`Params` with `assembly(p)` and/or `printables(p)` (or `printable(p)`).** `Params()` is made with no
   arguments and passed to each. Each returns a `dict` of part name to build123d shape (anything else fails the
   build). `assembly` gives the layout `assembly`: the parts as they are put together. `printables` gives the
   layout `print`: the parts as they are printed (flat side down, each on its own). Where parts of the print
   layout overlap, torno spreads them apart along +X for display, and refuses distances, clearances and overlaps
   between parts it moved: fit is checked in `assembly`.
2. **Else `Params` with `make_<part>(p)` functions**, the module's own, each taking `p` alone: one part per
   function, named after it, in the layout `main`. Only what returns a solid is kept.
3. **Else the solid shapes at the top level of the module** (names not starting with `_`) are the parts of
   `main`.

A layout with no part is dropped; a file that gives none fails with `no_scene`, saying what it found.

## Groups

When parts belong together (one of two alternatives, a sub-assembly, the pieces a part is cut into), say so in
the model with an optional `groups(p)`, beside `assembly` and `printables`. It is called with the same `Params()`
and returns a `dict` of group name to the names of its parts:

```
def groups(p: Params):
    return {"flat": ["flat-left", "flat-centre", "flat-right"], "aggressive": ["aggressive-left", "aggressive-right"]}
```

- One level only, and a part is in one group at most. A group is across layouts, by part name: in each layout it
  is those of its parts the layout has.
- A group name has no `/`, is not of the form `M<n>`, and is not the name of a part. A part name it lists must be
  in some layout. Otherwise the build fails saying what is wrong: a part renamed and not in its group is told at
  once.
- The user sees the groups in the layers list (fold, hide, show only that group). Group names are taken wherever
  parts are named: `parts` of `mcp__torno__show`, `mcp__torno__look` and `mcp__torno__save_view`, `refs` of
  `mcp__torno__highlight` and `ref` of `mcp__torno__describe` (the box of its parts and their volume).
  `mcp__torno__scene` and `state.md` list them.
- Name the parts with the group as a prefix (`flat-centre`), so that a reader of the file sees it too.
- Asked to group parts, edit `groups(p)` in the model: torno keeps no groups of its own.

## Checks

What must stay true when a size changes can be declared in the model, with an optional `checks(p)` beside `groups`.
It is called with the same `Params()` and returns a list of declarations, which torno measures with the kernel after
every build. A declaration is data, not a function: torno says whether each result is exact.

```
def checks(p: Params):
    return [
        {"name": "lid fits the tub", "kind": "clearance", "a": "lid", "b": "tub", "min": p.clearance - 0.05, "max": p.clearance + 0.05},
        {"name": "tub is one body", "kind": "solids", "a": "tub", "equals": 1},
        {"name": "walls", "kind": "thin", "a": "tub", "min": 1.2, "layout": "print"},
        {"name": "fits the bed", "kind": "bed", "size": [256, 256, 256]},
    ]
```

- `name` and `kind` are required. `a` and `b` are part names or group names (a group stands for its parts), never a
  face or edge number, which changes with the model. `layout` is optional.
- Kinds: `clearance` (the least distance between `a` and `b`), `overlap` (the volume they share: wants none
  unless told), `solids` (how many solids `a` has), `volume` (mm³), `thin` (a wall under `min` mm), `overhang`
  (faces facing down steeper than `angle`, 45 by default), `mesh` (the part's mesh is closed) and `bed` (the layout
  fits `size`).
- What is wanted: `min` and/or `max`, or `equals`, or `expected` with `tolerance` or `percent`. Read sizes from
  `Params`, as everywhere else.
- A declaration that is not one fails the build and says what is wrong. A check that does not pass never fails the
  build: it is told to you after the build, after the user's dimensions, and listed in the window as the model's own
  checks. It is not a stop sign: it holds nothing back.
- Read a result for what it says. `thin` is found by sampling, so "none found" is not "none there"; a volume that is
  not exact says so. A pass is what was measured, not proof that the part is right: do not tell the user that the
  part is verified.
- The user's dimensions stay the user's. A check never replaces one, and never silences one.
- Do not make a check pass by weakening it. torno compares each build's checks with the build before and tells the
  user when you removed one or made it easier to pass (`min` lowered, `max` raised, a larger bed). If a requirement
  really changed, say so in your answer when you change the check.

## Params is the one source of sizes

Every size, clearance and count is a field of `Params`, with a default; functions read `p.wall`, never a number
written inline. A change of size is then one edit, and the parts that must fit each other read the same field.

## Template

```python
"""A box with a lid that sits on it."""

from dataclasses import dataclass

from build123d import Axis, Box, Location, Pos, Rot, fillet


@dataclass(frozen=True)
class Params:
    width: float = 60.0
    depth: float = 40.0
    height: float = 30.0
    wall: float = 2.0
    lid_height: float = 4.0
    clearance: float = 0.2
    rounding: float = 1.0


def make_tub(p: Params):
    outer = Box(p.width, p.depth, p.height)
    inner = Pos(0, 0, p.wall) * Box(p.width - 2 * p.wall, p.depth - 2 * p.wall, p.height)
    tub = outer - inner
    return fillet(tub.edges().filter_by(Axis.Z), p.rounding)


def make_lid(p: Params):
    plate = Box(p.width, p.depth, p.wall)
    lip_w = p.width - 2 * p.wall - 2 * p.clearance
    lip_d = p.depth - 2 * p.wall - 2 * p.clearance
    lip = Box(lip_w, lip_d, p.lid_height - p.wall)
    # Rounded as the tub's inside is, or its square corners would reach into the tub's rounded ones.
    lip = Pos(0, 0, -(p.lid_height - p.wall) / 2 - p.wall / 2) * fillet(lip.edges().filter_by(Axis.Z), p.rounding)
    return plate + lip


def assembly(p: Params):
    """As put together: the lid on the tub."""
    return {
        "tub": make_tub(p),
        "lid": make_lid(p).moved(Location((0, 0, p.height / 2 + p.wall / 2))),
    }


def printables(p: Params):
    """As printed: each part flat on the bed (torno spreads them apart along X)."""
    return {
        "tub": make_tub(p),
        "lid": Rot(180, 0, 0) * make_lid(p),
    }


def checks(p: Params):
    """What must stay true when a size changes; torno measures it at every build (see Checks)."""
    return [
        {"name": "lid does not overlap the tub", "kind": "overlap", "a": "lid", "b": "tub"},
        {"name": "tub is one body", "kind": "solids", "a": "tub", "equals": 1},
    ]


# Parts that belong together, for the layers list and the tools (optional; see Groups):
# def groups(p: Params):
#     return {"box": ["tub", "lid"]}
```

Having both `assembly` and `printables`, this file has the layouts `assembly` and `print`; the `make_` functions
are only helpers here, since the first convention wins.
