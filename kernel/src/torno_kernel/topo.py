"""The kernel's canonical order of a shape's faces and edges.

Index ``i`` here is index ``i`` in the tessellation's per-face and per-edge
arrays. Faces come out in the same order as build123d's ``shape.faces()``.
Edges do not match ``shape.edges()``, which drops degenerate edges such as a
sphere's pole; they are kept here so the indices stay aligned with the mesh.
"""

from typing import Any

from .ocp import (
    TopAbs_EDGE,
    TopAbs_FACE,
    TopAbs_SOLID,
    TopAbs_WIRE,
    TopExp,
    TopTools_IndexedMapOfShape,
    downcast,
)


def faces(shape: Any) -> list[Any]:
    """The shape's distinct faces as ``TopoDS_Face``, in canonical order."""
    return _subshapes(shape, TopAbs_FACE)


def edges(shape: Any) -> list[Any]:
    """The shape's distinct edges as ``TopoDS_Edge``, in canonical order."""
    return _subshapes(shape, TopAbs_EDGE)


def solids(shape: Any) -> list[Any]:
    """The shape's distinct solids as ``TopoDS_Solid``: none of a shell or a lone face."""
    return _subshapes(shape, TopAbs_SOLID)


def wires(shape: Any) -> list[Any]:
    """The shape's distinct wires as ``TopoDS_Wire``: of a face, its outer one and its holes."""
    return _subshapes(shape, TopAbs_WIRE)


def loose_faces(shape: Any) -> int:
    """How many of the shape's faces are of none of its solids."""
    of_solids = TopTools_IndexedMapOfShape()
    for solid in solids(shape):
        TopExp.MapShapes_s(solid, TopAbs_FACE, of_solids)
    return len(faces(shape)) - of_solids.Extent()


def what(shape: Any) -> str:
    """What kind of shape this is, with its article: ``a shell``, ``a face``, ``a compound``."""
    wrapped = getattr(shape, "wrapped", shape)
    # TopAbs_SHELL, by whichever name the enum goes in this OCP.
    kind = str(wrapped.ShapeType()).rsplit("_", 1)[-1].lower()
    return f"{'an' if kind[:1] in 'aeiou' else 'a'} {kind}"


def _subshapes(shape: Any, kind: Any) -> list[Any]:
    wrapped = getattr(shape, "wrapped", shape)
    found = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(wrapped, kind, found)
    return [downcast(found.FindKey(i)) for i in range(1, found.Extent() + 1)]
