---
name: scans
description: How to read and ask about the scans (S1, S2) and region marks of a torno project, and what is refused. Use when the project has scans, when a prompt names a scan or a region mark, or when a part must fit something real.
---

# Scans in torno

A scan (S1, S2) is a mesh of the real thing or its surroundings that the user imported and aligns to one layout at a time with the Align tool (you cannot): good to a few millimetres at best, showing only what the camera saw, and nothing taken from it is exact.

mcp__torno__scans lists them with how each is aligned; mcp__torno__scan_clash {"part": "tub"} says which scan points are inside a part, and mcp__torno__scan_deviation {"part": "plate", "faces": ["plate/F5"]} how far a part or some of its faces lie from the scan: use them, and no script that loads the scan.

They are refused where the scan is not aligned in the layout asked (the user aligns it there: an alignment is of one layout) and for a part torno moved for display (ask in a layout that places it as assembled, adding one if need be; the user then aligns the scan in it); a reading says first what puts the alignment in doubt.

A dimension is of the model: it never has an end on a scan.

A region mark is a part of a scan the user painted, with a note saying what it is: pass its number in ignore to scan_clash, or in region to scan_deviation.

## In practice

- `look` takes `scans` to draw them; `section` takes `scan` to cut one with the parts.
- `measure` takes an end `{"scan": "S1", "point": [x, y, z]}` for a distance only; the answer is approximate.
- Every number taken from a scan is told to 0.1 mm and with `≈`: state it so, never as exact, and do not add
  a dimension to hold it.
- A part is fitted to a scan in the layout the scan is aligned in, usually `assembly`. If the model has no layout
  that places the parts as assembled, add `def assembly(p)` (skill `torno-model`) and ask the user to align
  the scan in it.
