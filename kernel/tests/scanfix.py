"""Scans made by test code: small, exact, and never a file in the repository."""

import struct
from pathlib import Path

import numpy as np

_BOX = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
        [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]


def box(size=(40.0, 30.0, 5.0), centre=(0.0, 0.0, 0.0)):
    """A box: 8 vertices, 12 triangles facing out. Vertex 4·i + 2·j + k is at (±x, ±y, ±z), minus first."""
    half = np.array(size) / 2
    corners = [[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    return np.array(corners, dtype=np.float64) * half + np.array(centre), np.array(_BOX)


def grid(count=30, cell=1.0, z=0.0):
    """A flat square sheet facing +Z: ``count`` vertices a side, ``cell`` apart, centred on the Z axis.

    With an even count no vertex has a whole-number coordinate: 30 gives -14.5 to 14.5.
    """
    along = (np.arange(count) - (count - 1) / 2) * cell
    x, y = np.meshgrid(along, along, indexing="ij")
    vertices = np.stack([x.ravel(), y.ravel(), np.full(count * count, float(z))], axis=1)
    i, j = np.meshgrid(np.arange(count - 1), np.arange(count - 1), indexing="ij")
    a = (i * count + j).ravel()
    b, c, d = a + count, a + count + 1, a + 1
    return vertices, np.concatenate([np.stack([a, b, c], axis=1), np.stack([a, c, d], axis=1)])


def write_stl(path: Path, vertices, triangles) -> Path:
    corners = np.asarray(vertices, dtype="<f4")[np.asarray(triangles)]
    with open(path, "wb") as out:
        out.write(b"\0" * 80 + struct.pack("<I", len(corners)))
        for a, b, c in corners:
            out.write(struct.pack("<12fH", 0, 0, 0, *a, *b, *c, 0))
    return path


def write_ply(path: Path, vertices, triangles, colours=None) -> Path:
    head = ["ply", "format ascii 1.0", f"element vertex {len(vertices)}", "property float x", "property float y", "property float z"]
    if colours is not None:
        head += ["property uchar red", "property uchar green", "property uchar blue"]
    head += [f"element face {len(triangles)}", "property list uchar int vertex_indices", "end_header"]
    rows = [" ".join(map(str, [*v, *(colours[n] if colours is not None else [])])) for n, v in enumerate(np.asarray(vertices).tolist())]
    rows += [f"3 {a} {b} {c}" for a, b, c in np.asarray(triangles).tolist()]
    path.write_text("\n".join(head + rows) + "\n")
    return path


def write_obj(path: Path, vertices, triangles) -> Path:
    rows = [f"v {x} {y} {z}" for x, y, z in np.asarray(vertices).tolist()]
    rows += [f"f {a + 1} {b + 1} {c + 1}" for a, b, c in np.asarray(triangles).tolist()]
    path.write_text("\n".join(rows) + "\n")
    return path


TEXTURE = [[(200, 30, 30), (30, 200, 30)], [(30, 30, 200), (220, 220, 40)]]  # rows from the top; [1][0] is the bottom left


def write_glb(path: Path, vertices, triangles, uv=(0.25, 0.25)) -> Path:
    """A GLB as glTF has them: metres, Y up. Every vertex has the same ``uv`` of a 2 × 2 texture."""
    import trimesh
    from PIL import Image

    image = Image.fromarray(np.array(TEXTURE, dtype=np.uint8), "RGB")
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=image)
    visual = trimesh.visual.TextureVisuals(uv=np.tile(uv, (len(vertices), 1)), material=material)
    v = np.asarray(vertices, dtype=np.float64)
    in_gltf = np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1) / 1000.0  # mm, Z up → m, Y up
    trimesh.Trimesh(in_gltf, np.asarray(triangles), visual=visual, process=False).export(str(path))
    return path
