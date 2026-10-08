"""Entry point: ``python -m torno_kernel`` speaks frames on stdin and stdout."""

import os
import platform
import sys


def main() -> int:
    # Keep the real stdout for frames and point fd 1 at stderr, so nothing an
    # import or a model prints can land in the protocol stream.
    proto_out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)

    # Imported here so every forked worker starts with them already loaded.
    import build123d
    import ocp_tessellate.convert  # noqa: F401

    try:
        build123d.Text("warm", 10)  # loads the font machinery once, for all workers
    except Exception:
        pass

    from .supervisor import Supervisor

    versions = {"build123d": build123d.__version__, "python": platform.python_version()}
    return Supervisor(sys.stdin.fileno(), proto_out).run(versions)


if __name__ == "__main__":
    sys.exit(main())
