"""A small enclosure for a sensor board: a body, a lid that sits in it and a clip that holds the two."""

from dataclasses import dataclass

from build123d import Align, Axis, Box, Location, Pos, Rot, fillet

# Boxes grow from the middle of their bottom face, so a part stands on z = 0.
BASE = (Align.CENTER, Align.CENTER, Align.MIN)


@dataclass(frozen=True)
class Params:
    width: float = 72.0
    depth: float = 48.0
    height: float = 26.0
    wall: float = 2.4
    floor: float = 2.0
    rounding: float = 3.0
    lid_thickness: float = 2.4
    lip_depth: float = 4.0
    lip_wall: float = 1.6
    clearance: float = 0.35  # assumed: the gap on each side between the lid's lip and the body; 0.2 is usual for PLA
    notch_width: float = 10.0  # the cable's way out, in the back wall
    notch_height: float = 6.0
    clip_width: float = 12.0
    clip_thickness: float = 1.6
    clip_gap: float = 0.3
    clip_arm: float = 9.0  # how far the clip's arms reach in over the lid and under the body


def make_body(p: Params):
    outer = fillet(Box(p.width, p.depth, p.height, align=BASE).edges().filter_by(Axis.Z), p.rounding)
    cavity = Pos(0, 0, p.floor) * Box(p.width - 2 * p.wall, p.depth - 2 * p.wall, p.height, align=BASE)
    notch = Pos(0, p.depth / 2 - p.wall / 2, p.height - p.notch_height) * Box(p.notch_width, 2 * p.wall, p.notch_height + 1, align=BASE)
    return outer - cavity - notch


def make_lid(p: Params):
    """The plate on top (z 0 to the thickness) and the lip under it that sits inside the body."""
    plate = fillet(Box(p.width, p.depth, p.lid_thickness, align=BASE).edges().filter_by(Axis.Z), p.rounding)
    outer_w, outer_d = p.width - 2 * p.wall - 2 * p.clearance, p.depth - 2 * p.wall - 2 * p.clearance
    lip = Pos(0, 0, -p.lip_depth) * (
        Box(outer_w, outer_d, p.lip_depth, align=BASE) - Box(outer_w - 2 * p.lip_wall, outer_d - 2 * p.lip_wall, p.lip_depth, align=BASE)
    )
    return plate + lip


def make_clip(p: Params):
    """A C that wraps the front: over the lid, down the wall, under the floor. Where it is as put together."""
    t, gap = p.clip_thickness, p.clip_gap
    front = -p.depth / 2
    bottom = -gap - t
    top = p.height + p.lid_thickness + gap + t
    back = Pos(0, front - gap - t / 2, (bottom + top) / 2) * Box(p.clip_width, t, top - bottom)
    arm_y = front - gap - t + (t + gap + p.clip_arm) / 2
    over = Pos(0, arm_y, top - t / 2) * Box(p.clip_width, t + gap + p.clip_arm, t)
    under = Pos(0, arm_y, bottom + t / 2) * Box(p.clip_width, t + gap + p.clip_arm, t)
    return back + over + under


def _on_bed(shape):
    return Pos(0, 0, -shape.bounding_box().min.Z) * shape


def assembly(p: Params):
    """As put together: the lid on the body, the clip round the front."""
    return {
        "case-body": make_body(p),
        "case-lid": Location((0, 0, p.height)) * make_lid(p),
        "clip": make_clip(p),
    }


def printables(p: Params):
    """As printed: the body as it stands, the lid upside down, the clip on its side (torno spreads them along X)."""
    return {
        "case-body": make_body(p),
        "case-lid": _on_bed(Rot(180, 0, 0) * make_lid(p)),
        "clip": _on_bed(Rot(0, 90, 0) * make_clip(p)),
    }


def groups(p: Params):
    return {"case": ["case-body", "case-lid"]}
