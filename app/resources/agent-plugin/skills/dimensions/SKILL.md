---
name: dimensions
description: How to add, read and act on torno's dimensions, the marks that hold a measurement checked on every build. Use when a prompt lists "Dimensions (measured on rN):", when a dimension fails, or to leave a check of your own on a size.
---

# Dimensions in torno

A dimension is a mark that holds a measurement, taken again on every build: mcp__torno__add_mark {"kind": "dimension", "note": "wall", "measure": "distance", "a": "plate/F2", "b": "plate/F4", "expected": 8, "tolerance": 0.1} leaves one of your own.

Dimensions with an expected value are acceptance checks, the user’s above all: those that fail or could not be measured are listed under "Dimensions (measured on rN):" with every prompt until they pass, and that list is of build rN only.

After your own edit, once scene says the build is ok, read them again with mcp__torno__marks.

Once the first model builds, leave a dimension of your own per size given that two faces can carry.

## In practice

- `measure` is one of `distance` and `angle` (ends `a` and `b`), or `radius`, `diameter` and `thickness` (end
  `a`). An end is a ref (`plate/F2`), `{"ref": "plate/F2", "point": [x, y, z]}` or a mark. The tolerance, when
  none is given, is 0.05 mm or 0.1°.
- Ends on faces hold across edits; an end on an edge is lost when its edge is renumbered or moves by more than
  half a millimetre, and the dimension is then not measurable until it is placed again.
- A failing dimension of the user's is what they asked for: change the model until it passes, do not change the
  dimension. Only they resolve a dimension of theirs with an expected value (`resolve_mark` refuses it); it
  passes by itself.
- A dimension is of the model: never with an end on a scan. In a print layout torno spread apart, a distance
  between two parts it moved is refused: place it in `assembly`.
- `scene` counts the dimensions that pass, fail and are not measured; the head of the list says when a build is
  running or failed, so a FAIL of the build before is not a verdict on the edit.

## Checks of your own

- When: as soon as the first build of a project is ok, not later. The sizes the person states are otherwise checked
  by nobody, and the next edit can break one without a word.
- What: one dimension for each size given that two faces (or one face, for a radius, diameter or thickness) can
  carry, with `expected` and a `tolerance`. Up to 8; keep to the sizes that decide fit or function.
- Note each with its source, e.g. "brief: inner width 52".
- They stand as the acceptance checks of the project. They are yours, not the person's: you may resolve one that is
  wrong or no longer meant, and they may change its expected value (that is news to you, as with theirs) or delete it.
- Never with an end on a scan: a size taken from a scan is not exact.
