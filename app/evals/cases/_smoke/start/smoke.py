from dataclasses import dataclass
from build123d import Box, Cylinder, Pos
@dataclass(frozen=True)
class Params:
    pass
def assembly(p):
    return {'block': Box(30, 20, 10) - Cylinder(3, 10)}
