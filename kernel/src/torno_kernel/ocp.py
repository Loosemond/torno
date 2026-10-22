"""OpenCascade names that changed between OCP 7 and OCP 8."""

from typing import Any

from OCP.TopAbs import (
    TopAbs_COMPOUND,
    TopAbs_COMPSOLID,
    TopAbs_EDGE,
    TopAbs_FACE,
    TopAbs_SHELL,
    TopAbs_SOLID,
    TopAbs_VERTEX,
    TopAbs_WIRE,
)
from OCP.TopExp import TopExp
from OCP.TopoDS import TopoDS

try:
    from OCP.TopTools import (
        TopTools_IndexedDataMapOfShapeListOfShape,
        TopTools_IndexedMapOfShape,
    )
except ImportError:
    from OCP.collections import (
        IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as TopTools_IndexedDataMapOfShapeListOfShape,
    )
    from OCP.collections import (
        IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as TopTools_IndexedMapOfShape,
    )


try:
    from OCP.TDF import TDF_LabelSequence as LabelSequence
except ImportError:
    from OCP.collections import Sequence_TDF_Label as LabelSequence

try:
    from OCP.IFSelect import IFSelect_RetDone
except ImportError:
    from OCP.IFSelect import IFSelect_ReturnStatus

    IFSelect_RetDone = IFSelect_ReturnStatus.IFSelect_RetDone


def downcast(shape: Any) -> Any:
    """Return ``shape`` as its specific TopoDS subclass."""
    casts = {
        TopAbs_VERTEX: TopoDS.Vertex,
        TopAbs_EDGE: TopoDS.Edge,
        TopAbs_WIRE: TopoDS.Wire,
        TopAbs_FACE: TopoDS.Face,
        TopAbs_SOLID: TopoDS.Solid,
        TopAbs_COMPSOLID: TopoDS.CompSolid,
        TopAbs_COMPOUND: TopoDS.Compound,
    }
    return casts.get(shape.ShapeType(), lambda value: value)(shape)
