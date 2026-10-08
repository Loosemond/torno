import os
import signal
from dataclasses import dataclass


@dataclass(frozen=True)
class Params:
    pass


def assembly(p):
    os.kill(os.getpid(), signal.SIGSEGV)
