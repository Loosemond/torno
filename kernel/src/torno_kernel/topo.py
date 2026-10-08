"""The kernel's canonical order of a shape's faces and edges.

Index ``i`` here is index ``i`` in the tessellation's per-face and per-edge
arrays. Faces come out in the same order as build123d's ``shape.faces()``.
Edges do not match ``shape.edges()``, which drops degenerate edges such as a
sphere's pole; they are kept here so the indices stay aligned with the mesh.
"""

from typing import Any


def faces(shape: Any) -> list[Any]:
    """The shape's distinct faces as ``TopoDS_Face``, in canonical order."""
    from ocp_tessellate.ocp_utils import TopAbs_FACE

    return _subshapes(shape, TopAbs_FACE)


def edges(shape: Any) -> list[Any]:
    """The shape's distinct edges as ``TopoDS_Edge``, in canonical order."""
    from ocp_tessellate.ocp_utils import TopAbs_EDGE

    return _subshapes(shape, TopAbs_EDGE)


def _subshapes(shape: Any, kind: Any) -> list[Any]:
    # OCP comes from the user's workspace, so it is imported only when used.
    # ocp_tessellate's shims paper over the names OCP 8 changed.
    from ocp_tessellate.ocp_utils import TopExp, TopTools_IndexedMapOfShape, downcast

    wrapped = getattr(shape, "wrapped", shape)
    found = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(wrapped, kind, found)
    return [downcast(found.FindKey(i)) for i in range(1, found.Extent() + 1)]
