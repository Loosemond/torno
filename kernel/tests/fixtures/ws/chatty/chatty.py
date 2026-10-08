from dataclasses import dataclass

from build123d import Box

print("report line")


@dataclass(frozen=True)
class Params:
    pass


def assembly(p):
    print("report line")
    return {"plate": Box(20, 20, 2)}
