"""A model in the older convention: Params and one make_<part>(p) per part."""

from dataclasses import dataclass

from build123d import Box, Cylinder, Pos


@dataclass(frozen=True)
class Params:
    width: float = 60
    depth: float = 40


def make_stand(p: Params):
    return Box(p.width, p.depth, 10)


def make_speaker(p: Params, *, ghost: bool = False):
    return Pos(0, 0, 25) * Box(p.width - 10, p.depth - 10, 40)


def make_label(p: Params) -> str:
    """Not a part: what it returns is not a shape."""
    return f"{p.width:g} x {p.depth:g}"


def signature(p: Params, front_h: float):
    """Not a part: not named make_<part>."""
    return Cylinder(1, front_h)


def make_engraving(p: Params, depth: float):
    """Not a part: it cannot be called with the parameters alone."""
    return Cylinder(1, depth)


def make_nothing():
    """Not a part: it takes no parameters."""
    return Box(1, 1, 1)


def main() -> None:
    raise SystemExit("must not run")


if __name__ == "__main__":
    main()
