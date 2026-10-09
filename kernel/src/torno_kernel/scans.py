"""The import process: ``python -m torno_kernel.scans import|convert …``.

It is no part of the kernel that builds: it is started for one file, reads it
with trimesh, writes one ``mesh.bin`` in millimetres and Z up, says what it
wrote as one line of JSON, its last on stdout, and exits. Its stages go to
stderr. The source is only ever read, and nothing is written over but a mesh
torno wrote. Whatever goes wrong, a flag it does not know among it, is that
one line with ``ok`` false. trimesh and pillow are imported when a file is
read, and build123d never: this module must stay cheap to import.

Told to end (SIGTERM), it removes the file it was writing and exits with 143,
saying nothing. Killed outright it cannot: a ``mesh.bin.<pid>.tmp`` may then
be left beside the mesh, for whoever started it to sweep.
"""

import argparse
import hashlib
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import scanfile

FORMATS = (".glb", ".gltf", ".obj", ".ply", ".stl")
UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
MAX_TRIANGLES = 2_000_000
# More than this is refused before it is read: reading it would take the machine's memory.
MAX_SOURCE_BYTES = 2 << 30
MAX_SOURCE_TRIANGLES = 20_000_000
# How often the cell of a reduction grows before it is given up: by then it is 1.5 ** 64 of what it was.
MAX_REDUCTIONS = 64
# A mesh under this across, in its own numbers, is taken to be in metres: a scan 20 mm across is of nothing.
METRES_BELOW = 20.0


class ScanError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def guess(suffix: str, diagonal: float) -> tuple[str, str]:
    """The unit and the up axis a file is taken to have: glTF says metres and Y up; OBJ is by habit Y up."""
    if suffix in (".glb", ".gltf"):
        return "m", "y"
    return ("m" if diagonal < METRES_BELOW else "mm"), ("y" if suffix == ".obj" else "z")


def to_z_up(vertices: np.ndarray, up: str) -> np.ndarray:
    """(x, y, z) → (x, −z, y) of a Y-up mesh: what was up is +Z, and the frame stays right-handed."""
    return vertices if up == "z" else np.stack([vertices[:, 0], -vertices[:, 2], vertices[:, 1]], axis=1)


def from_z_up(vertices: np.ndarray, up: str) -> np.ndarray:
    return vertices if up == "z" else np.stack([vertices[:, 0], vertices[:, 2], -vertices[:, 1]], axis=1)


def load(path: Path, say: Callable[[str], None]) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, str]:
    """Vertices in the file's own numbers, triangles, colours or None, and where the colours are from."""
    try:
        import trimesh
        from PIL import Image
    except ImportError as e:
        raise ScanError(
            "bad_request",
            f"the scans extra is not installed: {e.name or 'a library'} could not be imported ({e}); "
            "a scan is read with the kernel package's extra `scans` (trimesh and pillow)",
        ) from e

    Image.MAX_IMAGE_PIXELS = None  # a scan's texture is 8192 × 8192 and more
    say("reading")
    try:
        scene = trimesh.load(str(path), force="scene", process=False)
    except Exception as e:
        raise ScanError("unreadable", f"{path.name} could not be read: {e}") from e
    vertices, triangles, colours, kinds, base, points_alone = [], [], [], set(), 0, False
    for node in scene.graph.nodes_geometry:
        transform, name = scene.graph[node]
        mesh = scene.geometry[name]
        faces = getattr(mesh, "faces", None)
        if faces is None or len(faces) == 0:
            found = getattr(mesh, "vertices", None)
            points_alone = points_alone or (found is not None and len(found) > 0)
            continue
        if base // 3 + len(faces) > MAX_SOURCE_TRIANGLES:
            raise ScanError("too_large", f"{path.name} has more than {MAX_SOURCE_TRIANGLES:,} triangles")
        points = trimesh.transformations.transform_points(np.asarray(mesh.vertices, dtype=np.float64), transform)
        colour, kind = _colours(mesh, say)
        kinds.add(kind)
        vertices.append(points)
        triangles.append(np.asarray(faces, dtype=np.int64) + sum(len(v) for v in vertices[:-1]))
        colours.append(colour)
        base += 3 * len(faces)
    if not triangles and points_alone:
        raise ScanError("no_triangles", f"{path.name} has no triangles: a point cloud cannot be shown or checked against")
    if not triangles:
        # A file cut short, or one that is something else under this name: trimesh reads nothing of it and says nothing.
        raise ScanError("unreadable", f"{path.name} could not be read as a {path.suffix.lower()} mesh: no triangle and no point was found in it")
    v, t = np.concatenate(vertices), np.concatenate(triangles)
    if all(c is None for c in colours):
        return (*_welded(v, t), None, "none")
    # A piece without colours of its own is the grey of an uncoloured scan.
    c = np.concatenate([np.full((len(vertices[n]), 4), (200, 200, 200, 255), np.uint8) if c is None else c for n, c in enumerate(colours)])
    c[:, 3] = 255
    return v, t, c, "texture" if "texture" in kinds else "vertex"


def _colours(mesh: Any, say: Callable[[str], None]) -> tuple[np.ndarray | None, str]:
    visual = getattr(mesh, "visual", None)
    kind = getattr(visual, "kind", None)
    if kind == "texture" and getattr(visual, "uv", None) is not None:
        material = visual.material
        if getattr(material, "baseColorTexture", None) is None and getattr(material, "image", None) is None:
            return None, "none"
        say("colours")
        return np.asarray(visual.to_color().vertex_colors, dtype=np.uint8).reshape(-1, 4).copy(), "texture"
    if kind == "vertex":
        return np.asarray(visual.vertex_colors, dtype=np.uint8).reshape(-1, 4).copy(), "vertex"
    return None, "none"


def _welded(vertices: np.ndarray, triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Vertices that are in the very same place made one: an STL has three of its own a triangle."""
    rows = np.ascontiguousarray(vertices).view([("", vertices.dtype)] * 3).reshape(-1)
    _, first, inverse = np.unique(rows, return_index=True, return_inverse=True)
    return vertices[first], inverse.reshape(-1)[triangles]


def reduce(vertices: np.ndarray, triangles: np.ndarray, colours: np.ndarray | None, most: int = MAX_TRIANGLES):
    """A mesh of more than ``most`` triangles in at most that many, by merging the vertices of each cell of a grid.

    The cell starts at 1/4096 of the mesh's diagonal and grows by half (not
    to the double: that would throw away up to eight times the triangles it
    needs to) until the triangles left are few enough, ``MAX_REDUCTIONS``
    times at most. A merged vertex stands at the mean of those it was and has
    the colour of the first. A triangle whose corners were merged is gone,
    and of triangles that have come to have the same three corners one is
    kept. Returns the mesh, and ``{"from": triangles before, "cell": mm}``,
    or None when nothing was done. A mesh of which nothing is left at that
    many triangles is ``too_large``.
    """
    if len(triangles) <= most:
        return vertices, triangles, colours, None
    low = vertices.min(axis=0)
    cell = float(np.linalg.norm(vertices.max(axis=0) - low)) / 4096
    faces = np.zeros((0, 3), dtype=np.int64)
    for _ in range(MAX_REDUCTIONS):
        keys = np.floor((vertices - low) / cell).astype(np.int64)
        packed = (keys[:, 0] << 42) | (keys[:, 1] << 21) | keys[:, 2]
        _, first, inverse = np.unique(packed, return_index=True, return_inverse=True)
        inverse = inverse.reshape(-1)
        faces = inverse[triangles]
        faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 2] != faces[:, 0])]
        # Of those with the same three corners, the first: whichever way round it names them.
        _, kept = np.unique(np.sort(faces, axis=1), axis=0, return_index=True)
        faces = faces[np.sort(kept)]
        if len(faces) <= most:
            break
        cell *= 1.5
    if len(faces) == 0 or len(faces) > most:
        raise ScanError("too_large", f"its {len(triangles):,} triangles could not be reduced to {most:,} or fewer with anything left of it")
    counts = np.bincount(inverse)
    merged = np.stack([np.bincount(inverse, weights=vertices[:, axis]) / counts for axis in range(3)], axis=1)
    return merged, faces, None if colours is None else colours[first], {"from": int(len(triangles)), "cell": cell}


def _said(written: dict[str, Any], unit: str, up: str, assumed: dict[str, bool], colours: str, reduced: Any, started: float) -> dict[str, Any]:
    return {"ok": True, "unit": unit, "up": up, "assumed": assumed, **written, "colours": colours, "reduced": reduced, "seconds": round(time.monotonic() - started, 2)}


def import_scan(source: Path, out: Path, unit: str | None, up: str | None, most: int, say: Callable[[str], None]) -> dict[str, Any]:
    started = time.monotonic()
    if most < 1:
        raise ScanError("bad_request", "--max-triangles is a whole number, 1 or more")
    if source.suffix.lower() not in FORMATS:
        raise ScanError("bad_request", f"{source.name} is not a scan torno reads: {', '.join(FORMATS[:-1])} or {FORMATS[-1]}")
    try:
        size = source.stat().st_size
    except OSError as e:
        raise ScanError("unreadable", f"{source.name} could not be read: {e.strerror or e}") from e
    if size > MAX_SOURCE_BYTES:
        raise ScanError("too_large", f"{source.name} is {size / 2**30:.1f} GiB: more than the 2 GiB torno reads")
    _may_write(source, out)
    say("hashing")
    digest = hashlib.sha256()
    try:
        with open(source, "rb") as file:
            while chunk := file.read(1 << 22):
                digest.update(chunk)
    except OSError as e:
        raise ScanError("unreadable", f"{source.name} could not be read: {e.strerror or e}") from e
    vertices, triangles, colours, kind = load(source, say)
    if not np.isfinite(vertices).all():
        raise ScanError("unreadable", f"{source.name} could not be read: a vertex is not finite")
    if not scanfile.area_of(vertices, triangles) > 0:
        raise ScanError("no_triangles", f"{source.name} has no triangle with an area: every one of its {len(triangles):,} is a point or a line")
    say("converting")
    guessed = guess(source.suffix.lower(), float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0))))
    assumed = {"unit": unit is None, "up": up is None}
    unit, up = unit or guessed[0], up or guessed[1]
    vertices = to_z_up(vertices, up) * UNIT_MM[unit]
    vertices, triangles, colours, reduced = reduce(vertices, triangles, colours, most)
    say("writing")
    try:
        written = scanfile.write_bin(out, vertices, triangles, colours)
    except ValueError as e:  # in the unit given it is too large for the file's numbers, or has no area left
        raise ScanError("unreadable", f"{source.name} could not be read: {e}") from e
    return {**_said(written, unit, up, assumed, kind, reduced, started), "source": {"bytes": size, "sha256": digest.hexdigest()}}


def _may_write(source: Path, out: Path) -> None:
    """Refuse an ``out`` that is the source, or anything there that is not a mesh torno wrote: a source is never written over."""
    if not out.parent.is_dir():
        raise ScanError("bad_request", f"the mesh cannot be written: there is no folder {out.parent}")
    if not os.path.lexists(out):
        return
    try:
        if os.path.samefile(source, out):
            raise ScanError("bad_request", f"{source.name} would be written over itself: the mesh goes to another file")
        with open(out, "rb") as file:
            ours = out.is_file() and file.read(len(scanfile.MAGIC)) == scanfile.MAGIC
    except OSError:
        ours = False
    if not ours:
        raise ScanError("bad_request", f"{out.name} is there and is not a mesh torno wrote: it is not written over")


def convert(path: Path, from_unit: str, to_unit: str, from_up: str, to_up: str, say: Callable[[str], None]) -> dict[str, Any]:
    """Rewrite a ``mesh.bin`` as if its source had been read with another unit and up axis. The source is not needed."""
    started = time.monotonic()
    try:
        vertices, triangles, colours = scanfile.read_bin(path)
    except (OSError, ValueError) as e:
        raise ScanError("unreadable", str(e)) from e
    say("converting")
    own = from_z_up(vertices.astype(np.float64) / UNIT_MM[from_unit], from_up)
    say("writing")
    try:
        written = scanfile.write_bin(path, to_z_up(own, to_up) * UNIT_MM[to_unit], triangles, colours)
    except ValueError as e:
        raise ScanError("unreadable", f"{path.name} could not be written in that unit: {e}") from e
    return _said(written, to_unit, to_up, {"unit": False, "up": False}, "none" if colours is None else "vertex", None, started)


class _Parser(argparse.ArgumentParser):
    """A parser whose complaint is the process's one line, not a usage text and a status of its own."""

    def error(self, message: str) -> Any:
        raise ScanError("bad_request", message)


def end_on_sigterm() -> None:
    """Told to end, leave as an exception does: whatever was being written is removed on the way (``scanfile._replaced``)."""

    def end(*_: Any) -> None:
        raise SystemExit(128 + signal.SIGTERM)

    signal.signal(signal.SIGTERM, end)


def main(argv: list[str]) -> int:
    parser = _Parser(prog="python -m torno_kernel.scans")
    commands = parser.add_subparsers(dest="command", required=True)
    read = commands.add_parser("import")
    read.add_argument("source", type=Path)
    read.add_argument("out", type=Path)
    read.add_argument("--unit", choices=list(UNIT_MM))
    read.add_argument("--up", choices=["y", "z"])
    read.add_argument("--max-triangles", type=int, default=MAX_TRIANGLES)
    change = commands.add_parser("convert")
    change.add_argument("mesh", type=Path)
    for name, choices in (("unit", list(UNIT_MM)), ("up", ["y", "z"])):
        change.add_argument(f"--from-{name}", choices=choices, required=True)
        change.add_argument(f"--to-{name}", choices=choices, required=True)

    def say(stage: str) -> None:
        print(f"stage: {stage}", file=sys.stderr, flush=True)

    try:
        args = parser.parse_args(argv)
        if args.command == "import":
            said = import_scan(args.source, args.out, args.unit, args.up, args.max_triangles, say)
        else:
            said = convert(args.mesh, args.from_unit, args.to_unit, args.from_up, args.to_up, say)
    except ScanError as e:
        said = {"ok": False, "error": {"kind": e.kind, "message": e.message}}
    except MemoryError:
        said = {"ok": False, "error": {"kind": "too_large", "message": "there was not enough memory to read it"}}
    except Exception as e:  # whatever a library raises on a file it does not like
        said = {"ok": False, "error": {"kind": "unreadable", "message": str(e) or type(e).__name__}}
    print(json.dumps(said, allow_nan=False), flush=True)
    return 0 if said["ok"] else 1


if __name__ == "__main__":
    end_on_sigterm()
    sys.exit(main(sys.argv[1:]))
