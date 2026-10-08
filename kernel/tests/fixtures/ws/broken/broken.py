from dataclasses import dataclass


@dataclass(frozen=True)
class Params:
    wall: float = 0.2


def assembly(p):
    raise ValueError("wall too thin")
