import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Params:
    pass


def assembly(p):
    print("starting slow work")
    time.sleep(60)
