# enclosure

A small box for a sensor board, to print in PLA on a 0.4 mm nozzle. The board is 60 by 36 mm and 14 mm tall with
its connector, and it lies flat on the floor of the box. A USB-C cable comes out through a notch in the back wall.

It has three parts: the body, a lid that sits on it with a lip inside the walls, and a clip that wraps the front
and holds the lid down. I want to open it now and then, so no screws and no glue.

What I need from it:

- The lid fits without a rattle: a gap of about 0.2 mm on each side of the lip.
- The cable notch fits the plug (14 mm wide with its strain relief).
- A flat place on the lid for a label, about 30 by 12 mm.
- Every part prints without supports: the body as it stands, the lid upside down, the clip on its side.

Sizes are fields of `Params` in `enclosure.py`; the clearance of the lid is marked "assumed", because I have not
printed one yet.
