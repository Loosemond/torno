---
name: printing
description: Rules for a part that will be 3D printed on an FDM printer: fits per side, wall thickness, overhangs, holes, orientation and the bed. Use when the model has a print layout, or when a fit, a clearance, a snap or a hole for a screw decides the design, and before the /printable prompt.
---

# Designing for FDM printing

Every number here is typical, for a 0.4 mm nozzle and PLA or PETG. It is not a property of the person's printer. Use
a typical number only as an `assumed` field of `Params` (a comment saying "assumed") until the person gives the
printer and the material; then record their answer as a field commented "person".

## The print profile

If the context says "Print profile of this project", the person has chosen a printer and a material for it. Their
numbers replace every typical number below: take the gaps of each fit, the least wall, the overhang angle, the density
and the bed from that line, record them as `Params` fields commented "person", and do not ask for them again. `check`
bed, thin and overhang then need no values, and `check` clearance takes `fit` (press, sliding or loose) to judge the
gap against the material's band. A profile is the person's numbers, not measured: a pass is not a print.

## Ask once

With no print profile, when a fit or printability decides the design, ask before the first model, in the one round the `torno-model` skill
allows (`AskUserQuestion`): the nozzle, the material and the bed (X x Y x Z in mm). Each option may carry a typical
value labelled as typical. If they answer "build with assumptions", build with the typical values and list them.

## Fits

A clearance is per side: the gap between the two faces is that much, so a hole is the peg plus twice it. Typical
ranges per side:

| fit | per side |
| --- | --- |
| press | 0.05 to 0.10 mm |
| snug | 0.10 to 0.15 mm |
| sliding | 0.20 to 0.30 mm |
| loose | 0.30 to 0.50 mm |

Each is a named field of `Params` (`slide_gap = 0.25  # assumed`), never a number in a function. Check the result
with `mcp__torno__check {"kind": "clearance", "a": "lid", "b": "tub"}` (add `"fit": "sliding"` when there is a profile) in a layout that places the parts as
assembled.

## Walls and small features

- Make walls a multiple of the line width (0.45 mm at a 0.4 mm nozzle): 0.9, 1.35, 1.8 mm. A wall under two lines
  is weak or empty.
- The least feature (a rib, a pin, a gap) is one line wide, 0.45 mm, and prints poorly. Keep to 0.8 mm or more.
- Check with `mcp__torno__check {"kind": "thin", "a": <part>, "min": 0.9}`, with the least the person's nozzle can
  print.

## Overhangs and bridges

- A face leaning more than 45 degrees from vertical needs support. Chamfer the underside of a ledge at 45 degrees
  rather than rounding it; a fillet is flat at its start.
- A hole with a horizontal axis in a vertical wall: draw its top as a teardrop (a point at 45 degrees) or a flat
  top, not a circle.
- A bridge across a gap prints to a few centimetres; beyond, add a support or a pillar.
- Check with `mcp__torno__check {"kind": "overhang", "a": <part>, "angle": 45}`.

## Holes

- Holes print undersize, a horizontal one more than a vertical one: add 0.1 to 0.2 mm to the diameter.
- A hole for a screw, a nut, a magnet or a heat-set insert takes its size from the datasheet of that part, or from
  the person. Never invent it. The `build123d` skill lists the sizes of screw, nut and insert holes.

## Orientation and the bed

- Put the flat side down in `printables(p)`: each part as it lies on the bed, its base on z = 0.
- A part is weak between layers: a load across the layers splits them. Orient a clip, a hook or a shaft so that
  the load runs along the layers.
- A chamfer of 0.4 to 0.6 mm at the edge that touches the bed keeps the elephant's foot out of a fit.
- Once the bed is known, `mcp__torno__check {"kind": "bed", "size": [x, y, z]}`.

## Say what is not known

A fit is checked by printing it. Of a clearance that `check` passes, say "rebuilt, not printed": the number is the
model's, not the printer's. Never say a fit works.
