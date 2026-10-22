"""The files a build leaves torno as: STEP, STL and 3MF, made by the worker that holds the shapes, and read back.

The kernel never writes a file. ``export`` answers with the file's bytes, the reply's blob; main writes them beside
the path the person chose (``<path>.<random>.tmp``) and asks ``export_check`` of that file, which this worker reads
back and holds against the shapes it made it of, before main gives it the name. A file that fails its check is
never named.

- STEP is the B-rep itself: the parts asked for, each a named child in its colour, of one layout, in mm. Read
  back, it has the same parts by name, each with as many solids, a volume within ``STEP_AGREES`` of the model's (or
  of its doubt) and the same box.
- STL (one part) and 3MF (a plate: each part a named object where the layout has it, made of a mesh of each of its
  solids when it has several) are meshes made for the file,
  not the screen's: no further from the faces than ``tolerance`` mm, the normals of a triangle's corners no more
  than ``angle`` degrees apart. Read back, each object is closed once its vertices are welded (``checks.WELD``):
  every side of a triangle is of one other, the other way round, none of three or more; no triangle has no area;
  it is in as many pieces as the part has shells; what it encloses is positive (it faces out) and within the chord
  loss the tolerance allows of the model's volume (``tess.MESH_SLACK`` tolerances over its area, and the volume's
  own doubt); and its box is the part's, within the same.

Nothing of the machine is in a file: no path, no user, no folder. The parts are the model's names.
"""

import ctypes
import io
import math
import os
import re
import struct
from pathlib import Path
from typing import Any

import numpy as np

from . import checks, extent, tess, topo
from .queries import QueryError, WithBlob, box_of, boxed_exactly_of, need_layout, need_part, need_solid, volume_of

FORMATS = ("step", "stl", "3mf")
# How far a triangle of a mesh file may be from the faces it stands for, mm, by default; and the least and the most.
TOLERANCE = 0.01
TOLERANCES = (0.001, 1.0)
# How far apart, in degrees, the normals of a triangle's corners may be, by default; and the least and the most.
ANGLE = 5.0
ANGLES = (0.5, 45.0)
# No mesh file has more triangles than this: a tolerance that would make more is refused before anything is meshed
# (``estimate``). OCC took 22 s to mesh a sphere of 50 mm into 500,000 triangles and 68 s into a million, and 57 s a
# torus into 494,000 and 350 s into a million: past about this, a file is not made in the time an export has (``EXPORT_TIMEOUT``).
MOST_TRIANGLES = 500_000
# The coarsest a part is meshed at to estimate what the asked tolerance makes: this share of its box's diagonal, and
# this angle in degrees (or the asked ones when they are coarser).
_ROUGH_SHARE = 1 / 500
_ROUGH_ANGLE = 15.0
# The faces straight along one way, whose triangles are strips: a flat face's are made for its outline alone.
_STRAIGHT_ALONG = ("PLANE", "CYLINDER", "CONE", "SURFACEOFEXTRUSION")
# Solids nearer each other than this, mm, touch (``checks._TOUCHING``).
_TOUCHING = 1e-7
# A volume read back from a STEP file agrees with the model's within this fraction of it, or its doubt.
STEP_AGREES = 1e-6
# A triangle of less area than this, mm², has none: a slicer cannot tell which way it faces.
NO_AREA = 1e-12
# An STL is 80 bytes of header, a count, then this per triangle (little-endian).
STL_TRIANGLE = np.dtype([("normal", "<f4", (3,)), ("corners", "<f4", (3, 3)), ("attribute", "<u2")])
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def export(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> WithBlob:
    """Answer ``export``: ``format``, ``layout``, ``parts`` (names), and ``tolerance`` (mm) and ``angle`` (degrees)
    for a mesh, ``colors`` (part name to ``#rrggbb``) and ``name`` (the STEP's top product) if given.

    The result says what is in the file: ``format``, ``layout``, ``bytes``, and of each part its ``name``,
    ``solids``, ``volume`` and ``volumeExact``; of a mesh its ``triangles`` (and each part's), ``tolerance`` and
    ``angle``. The file is the blob.
    """
    asked = _asked(shapes, args)
    format, layout, parts = asked["format"], asked["layout"], asked["parts"]
    told: list[dict[str, Any]] = []
    for name in parts:
        key = f"{layout}:{name}"
        volume = volume_of(shapes[key], key, kept)
        told.append({"name": name, "solids": len(topo.solids(shapes[key])), "volume": volume.value, "volumeExact": volume.exact})
    if format == "step":
        data = _step(shapes, layout, parts, asked["colors"], asked["name"])
        return WithBlob({"format": format, "layout": layout, "parts": told, "bytes": len(data)}, data)
    tolerance, angle = asked["tolerance"], asked["angle"]
    # Refused before a part is meshed: OCC's meshing cannot be stopped once it has begun.
    expected = sum(estimate(shapes[f"{layout}:{name}"], tolerance, angle) for name in parts)
    if expected > MOST_TRIANGLES:
        raise QueryError("bad_request", _too_fine(parts, tolerance, angle, expected))
    if format == "stl":
        touching = _touching(shapes[f"{layout}:{parts[0]}"])
        if touching:
            raise QueryError(
                "bad_request", f"{parts[0]} is {touching} solids that touch: fuse them in the model, or export 3MF"
            )
    meshes = []
    total = 0
    for name, part in zip(parts, told, strict=True):
        shape = shapes[f"{layout}:{name}"]
        # A part of several solids is a mesh of each in a 3MF: solids that touch share no edge a slicer would mend.
        pieces = [shape] if format == "stl" or len(topo.solids(shape)) < 2 else topo.solids(shape)
        made = [mesh(piece, tolerance, angle, name) for piece in pieces]
        count = sum(len(triangles) for _, triangles in made)
        total += count
        if total > MOST_TRIANGLES:
            raise QueryError("bad_request", _too_fine(parts, tolerance, angle, total))
        part["triangles"] = count
        meshes.append((name, made))
    data = _stl(meshes[0][0], *meshes[0][1][0]) if format == "stl" else _3mf(meshes, asked["colors"])
    result = {
        "format": format,
        "layout": layout,
        "parts": told,
        "triangles": total,
        "tolerance": asked["tolerance"],
        "angle": asked["angle"],
        "bytes": len(data),
    }
    return WithBlob(result, data)


def export_check(shapes: dict[str, Any], args: dict[str, Any], kept: dict[Any, Any] | None) -> dict[str, Any]:
    """Answer ``export_check``: the file at ``path``, read back and held against the shapes ``export`` was asked
    of with the same arguments.

    ``passed`` is whether it may take its name; ``problems`` says, a sentence each, what is wrong with it. Of each
    part read back, ``objects`` says what was found (by name, in the order asked); ``volumeDeviation`` is the
    largest of theirs, in percent of the model's volume. Of a mesh, ``triangles`` is how many it has in all.
    """
    asked = _asked(shapes, args)
    path = args.get("path")
    if not isinstance(path, str) or not os.path.isabs(path):
        raise QueryError("bad_request", "export_check needs args.path, the whole path of the file to read")
    held = {} if kept is None else kept
    try:
        if asked["format"] == "step":
            said = _check_step(shapes, asked, path, held)
        else:
            said = _check_mesh(shapes, asked, path, held)
    except _Unread as e:
        said = {"objects": [], "problems": [str(e)]}
    deviations = [one["volumeDeviation"] for one in said["objects"] if one.get("volumeDeviation") is not None]
    return {
        "passed": not said["problems"],
        "format": asked["format"],
        "problems": said["problems"],
        "objects": said["objects"],
        **({"triangles": said["triangles"]} if "triangles" in said else {}),
        "volumeDeviation": max(deviations) if deviations else None,
    }


# What is asked


def _asked(shapes: dict[str, Any], args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        args = {}
    format = args.get("format")
    if format not in FORMATS:
        raise QueryError("bad_request", f"an export needs args.format, one of {', '.join(FORMATS)}")
    layout, parts = args.get("layout"), args.get("parts")
    if not isinstance(layout, str):
        raise QueryError("bad_request", "an export needs args.layout, a string")
    if not isinstance(parts, list) or not parts or not all(isinstance(part, str) for part in parts):
        raise QueryError("bad_request", "an export needs args.parts, the names of one part or more")
    if len(set(parts)) != len(parts):
        raise QueryError("bad_request", "args.parts names a part twice")
    need_layout(shapes, layout)
    for part in parts:
        shape = need_part(shapes, layout, part)
        if format != "step":
            need_solid(shape, part)
            loose = topo.loose_faces(shape)
            if loose:
                raise QueryError(
                    "bad_request", f"{part} has {loose} {'face' if loose == 1 else 'faces'} of no solid: an STL or a 3MF is of solids"
                )
    if format == "stl" and len(parts) != 1:
        raise QueryError("bad_request", f"an STL is of one part, and {len(parts)} were named: a plate of several is a 3MF")
    tolerance = _number(args, "tolerance", TOLERANCE, TOLERANCES, "mm")
    angle = _number(args, "angle", ANGLE, ANGLES, "degrees")
    colors = args.get("colors", {})
    if not isinstance(colors, dict) or not all(isinstance(c, str) and _HEX.match(c) for c in colors.values()):
        raise QueryError("bad_request", "args.colors gives a part's name a colour as #rrggbb")
    name = args.get("name", layout)
    if not isinstance(name, str):
        raise QueryError("bad_request", "args.name, the name of the whole, is a string")
    return {"format": format, "layout": layout, "parts": parts, "tolerance": tolerance, "angle": angle, "colors": colors, "name": name}


def _number(args: dict[str, Any], key: str, default: float, within: tuple[float, float], unit: str) -> float:
    value = args.get(key, default)
    low, high = within
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not low <= value <= high
    ):
        raise QueryError("bad_request", f"args.{key} is a number of {unit} from {low:g} to {high:g}")
    return float(value)


class _Unread(Exception):
    """The file could not be read as what it should be: the one problem there is to tell of it."""


# STEP


def _step(shapes: dict[str, Any], layout: str, parts: list[str], colors: dict[str, str], name: str) -> bytes:
    """The STEP file of the parts, each a named, coloured component of one assembly, its name as the model has it.

    Written through OCC's XCAF document, not build123d's ``export_step``: that one hands a name to OCC as bytes of
    Latin-1, so ``ção`` comes out as mojibake, and its reader turns a space, a dot or a bracket into ``_``. Names
    are given here as UTF-8 (``TCollection_ExtendedString(name, True)``), which OCC writes as they are and reads back
    as they were (``read.step.codepage`` is UTF-8).
    """
    from OCP.Message import Message, Message_Gravity
    from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
    from OCP.STEPCAFControl import STEPCAFControl_Controller, STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_Controller, STEPControl_StepModelType
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.XCAFDoc import XCAFDoc_ColorType, XCAFDoc_DocumentTool

    from .ocp import IFSelect_RetDone

    for printer in Message.DefaultMessenger_s().Printers():
        printer.SetTraceLevel(Message_Gravity.Message_Fail)
    STEPControl_Controller.Init_s()
    STEPCAFControl_Controller.Init_s()
    doc = _xcaf_document()
    shapes_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors_tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    whole = shapes_tool.NewShape()
    TDataStd_Name.Set_s(whole, _named(name))
    for part in parts:
        shape = shapes[f"{layout}:{part}"]
        component = shapes_tool.AddComponent(whole, getattr(shape, "wrapped", shape), False)
        referred = TDF_Label()
        shapes_tool.GetReferredShape_s(component, referred)
        for label in (component, referred):
            TDataStd_Name.Set_s(label, _named(part))
        if part in colors:
            hex = colors[part]
            rgb = (int(hex[1:3], 16) / 255, int(hex[3:5], 16) / 255, int(hex[5:7], 16) / 255)
            colors_tool.SetColor(referred, Quantity_Color(*rgb, Quantity_TOC_sRGB), XCAFDoc_ColorType.XCAFDoc_ColorGen)
    shapes_tool.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    writer.SetColorMode(True)
    if not writer.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs):
        raise QueryError("exception", "OCC's STEP writer could not take the parts")
    written = io.BytesIO()
    if writer.WriteStream(written) != IFSelect_RetDone:
        raise QueryError("exception", "OCC's STEP writer wrote nothing")
    return written.getvalue()


def _xcaf_document() -> Any:
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFApp import XCAFApp_Application

    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    XCAFApp_Application.GetApplication_s().InitDocument(doc)
    return doc


def _named(name: str) -> Any:
    from OCP.TCollection import TCollection_ExtendedString

    return TCollection_ExtendedString(name, True)


def _name_of(label: Any) -> str | None:
    from OCP.TCollection import TCollection_AsciiString
    from OCP.TDataStd import TDataStd_Name

    found = TDataStd_Name()
    if not label.FindAttribute(TDataStd_Name.GetID_s(), found):
        return None
    # As UTF-8: an extended string is turned into one byte a character only when given a character to put for the rest.
    return TCollection_AsciiString(found.Get()).ToCString()


def _read_step(path: str) -> list[tuple[str | None, Any]]:
    """The components of a STEP file's top assembly, each its name and its shape where the file places it; of a
    file whose top is no assembly, its top shapes."""
    from OCP.STEPCAFControl import STEPCAFControl_Controller, STEPCAFControl_Reader
    from OCP.STEPControl import STEPControl_Controller
    from OCP.TDF import TDF_Label
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    from .ocp import IFSelect_RetDone, LabelSequence

    STEPControl_Controller.Init_s()
    STEPCAFControl_Controller.Init_s()
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise _Unread("the file could not be read back as STEP")
    doc = _xcaf_document()
    if not reader.Transfer(doc):
        raise _Unread("the file was read as STEP, and OCC could make no shape of it")
    shapes_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    tops = LabelSequence()
    shapes_tool.GetFreeShapes(tops)
    found: list[tuple[str | None, Any]] = []
    for i in range(1, tops.Length() + 1):
        top = tops.Value(i)
        if not shapes_tool.IsAssembly_s(top):
            found.append((_name_of(top), shapes_tool.GetShape_s(top)))
            continue
        components = LabelSequence()
        shapes_tool.GetComponents_s(top, components)
        for j in range(1, components.Length() + 1):
            component = components.Value(j)
            referred = TDF_Label()
            shapes_tool.GetReferredShape_s(component, referred)
            found.append((_name_of(referred) or _name_of(component), shapes_tool.GetShape_s(component)))
    return found


def _check_step(shapes: dict[str, Any], asked: dict[str, Any], path: str, held: dict[Any, Any]) -> dict[str, Any]:
    if not Path(path).is_file():
        raise _Unread(f"there is no file at {path} to read back")
    try:
        read = _read_step(path)
    except _Unread:
        raise
    except Exception as e:
        raise _Unread(f"the file could not be read back as STEP: {str(e) or type(e).__name__}") from None
    found = {label: shape for label, shape in read}
    layout, problems, objects = asked["layout"], [], []
    if [label for label, _ in read] != asked["parts"]:
        missing = [part for part in asked["parts"] if part not in found]
        other = [label for label in found if label not in asked["parts"]]
        problems.append(
            "read back, it holds "
            + (", ".join(repr(label) for label in found) or "no part")
            + " where it should hold "
            + ", ".join(repr(part) for part in asked["parts"])
            + (f": {', '.join(missing)} {'is' if len(missing) == 1 else 'are'} missing" if missing else "")
            + (f"; {', '.join(other)} should not be there" if other else "")
        )
    for part in asked["parts"]:
        if part not in found:
            continue
        key = f"{layout}:{part}"
        shape, again = shapes[key], found[part]
        model = volume_of(shape, key, held)
        solids, read_solids = len(topo.solids(shape)), len(topo.solids(again))
        volume = extent.volume(again)
        deviation = _percent(volume.value, model.value)
        within = max(STEP_AGREES * model.value, 2 * (model.spread + volume.spread))
        low, high = extent.box(again)
        model_low, model_high = extent.box(shape)
        slack = STEP_AGREES * max(math.dist(model_low, model_high), 1.0)
        boxed = all(abs(a - b) <= slack for a, b in zip([*low, *high], [*model_low, *model_high], strict=True))
        objects.append(
            {
                "name": part,
                "solids": read_solids,
                "volume": volume.value,
                "modelVolume": model.value,
                "volumeExact": model.exact and volume.exact,
                "volumeDeviation": deviation,
                "box": {"min": low, "max": high},
            }
        )
        if read_solids != solids:
            problems.append(f"{part}: read back it has {read_solids} solids, and the model's has {solids}")
        if abs(volume.value - model.value) > within:
            problems.append(f"{part}: read back its volume is {volume.value:.6g} mm³, and the model's is {model.value:.6g} mm³")
        if not boxed:
            problems.append(f"{part}: read back its box is not the model's")
    return {"objects": objects, "problems": problems}


# Meshes


def mesh(shape: Any, tolerance: float, angle: float, name: str = "the part") -> tuple[np.ndarray, np.ndarray]:
    """A mesh of a part for a file: vertices (N × 3, mm, the object frame) welded as ``checks.open_edges`` welds,
    and triangles (M × 3) facing out, none with two corners in one place.

    Meshed by OCC on a copy of the shape, at ``tolerance`` mm and ``angle`` degrees, both absolute: the shape the
    worker holds keeps the triangulation it is drawn with.
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.TopLoc import TopLoc_Location

    copied = BRepBuilderAPI_Copy(getattr(shape, "wrapped", shape), True, False).Shape()
    BRepMesh_IncrementalMesh(copied, tolerance, False, math.radians(angle), True)
    points: list[np.ndarray] = []
    corners: list[np.ndarray] = []
    offset = 0
    for index, face in enumerate(topo.faces(copied)):
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is None:
            raise QueryError("exception", f"{name}/F{index} could not be meshed at {tolerance:g} mm")
        moved = None if location.IsIdentity() else location.Transformation()
        nodes = np.empty((triangulation.NbNodes(), 3))
        for i in range(triangulation.NbNodes()):
            node = triangulation.Node(i + 1)
            if moved is not None:
                node = node.Transformed(moved)
            nodes[i] = (node.X(), node.Y(), node.Z())
        faces = np.empty((triangulation.NbTriangles(), 3), dtype=np.int64)
        for i in range(triangulation.NbTriangles()):
            faces[i] = triangulation.Triangle(i + 1).Get()
        if face.Orientation() == TopAbs_REVERSED:
            faces = faces[:, [0, 2, 1]]
        points.append(nodes)
        corners.append(faces - 1 + offset)
        offset += len(nodes)
    if not points:
        return np.empty((0, 3)), np.empty((0, 3), dtype=np.int64)
    vertices = np.concatenate(points)
    triangles = np.concatenate(corners)
    # Each face is meshed apart: its corners on an edge are one with its neighbour's once welded.
    _, first, welded = np.unique(checks.welded(vertices), return_index=True, return_inverse=True)
    triangles = welded.reshape(-1)[triangles]
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    # A pole, or a corner where edges of no length meet: two corners in one place make no triangle.
    return vertices[first], triangles[(a != b) & (b != c) & (c != a)]


def estimate(shape: Any, tolerance: float, angle: float) -> float:
    """About how many triangles OCC makes of a part at ``tolerance`` mm and ``angle`` degrees, worked out in a moment.

    The part is meshed coarsely (a 500th of its diagonal, 15°) and the count scaled face by face: a curved face's
    triangles go as one over the deflection, or as one over the square of the angle, whichever holds them closer; a
    face straight along one way (a plane, a cylinder, a cone) as a curve's segments, one over the square root of the deflection or one over the angle. On the
    parts tried it was never under the count, and at most a few times over it.
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopLoc import TopLoc_Location

    low, high = extent.box(shape)
    rough = max(tolerance, _ROUGH_SHARE * math.dist(low, high))
    rough_angle = max(angle, _ROUGH_ANGLE)
    copied = BRepBuilderAPI_Copy(getattr(shape, "wrapped", shape), True, False).Shape()
    BRepMesh_IncrementalMesh(copied, rough, False, math.radians(rough_angle), True)
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    # A face curved both ways fills with triangles; one straight along a way (a plane, a cylinder, a cone, an
    # extrusion) has them in strips across it, which go as a curve's segments do.
    curved = max(rough / tolerance, (rough_angle / angle) ** 2)
    flat = max(math.sqrt(rough / tolerance), rough_angle / angle)
    expected = 0.0
    for face in topo.faces(copied):
        triangulation = BRep_Tool.Triangulation_s(face, TopLoc_Location())
        if triangulation is not None:
            straight = extent._kind(BRepAdaptor_Surface(face)) in _STRAIGHT_ALONG
            expected += triangulation.NbTriangles() * (flat if straight else curved)
    return expected


def _too_fine(parts: list[str], tolerance: float, angle: float, triangles: float) -> str:
    return (
        f"at {tolerance:g} mm and {angle:g}° {', '.join(parts)} would be about {triangles:,.0f} triangles, more than "
        f"the {MOST_TRIANGLES:,} a file can be made of in the time an export has: take a coarser tolerance or angle"
    )


def _touching(shape: Any) -> int:
    """How many solids the part has, when two of them touch or overlap: 0 otherwise."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    solids = topo.solids(shape)
    if len(solids) < 2:
        return 0
    boxes = [extent.box(solid) for solid in solids]
    for i in range(len(solids)):
        for j in range(i + 1, len(solids)):
            (a_low, a_high), (b_low, b_high) = boxes[i], boxes[j]
            if any(a_low[k] > b_high[k] + _TOUCHING or b_low[k] > a_high[k] + _TOUCHING for k in range(3)):
                continue
            between = BRepExtrema_DistShapeShape(solids[i], solids[j])
            if between.IsDone() and between.Value() <= _TOUCHING:
                return len(solids)
    return 0


def _stl(name: str, vertices: np.ndarray, triangles: np.ndarray) -> bytes:
    corners = vertices[triangles]
    normals = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    rows = np.zeros(len(triangles), dtype=STL_TRIANGLE)
    rows["normal"] = normals
    rows["corners"] = corners
    # Never beginning "solid", which a reader takes for an STL of text. Millimetres: an STL has no unit.
    header = f"torno, mm: {name}".encode()[:80].ljust(80, b" ")
    return header + struct.pack("<I", len(triangles)) + rows.tobytes()


def _3mf(meshes: list[tuple[str, list[tuple[np.ndarray, np.ndarray]]]], colors: dict[str, str]) -> bytes:
    """A plate: each part a mesh object of its name; a part of several solids an object of its name made of a mesh
    of each (``<name> 1``, ``<name> 2``, …), which a slicer takes as the parts of one object."""
    from lib3mf import Lib3MF

    wrapper = _lib3mf()
    model = wrapper.CreateModel()
    model.SetUnit(Lib3MF.ModelUnit.MilliMeter)
    materials = model.AddBaseMaterialGroup() if any(name in colors for name, _ in meshes) else None
    for name, pieces in meshes:
        color = None
        if materials is not None and name in colors:
            hex = colors[name]
            color = materials.AddMaterial(name, wrapper.RGBAToColor(int(hex[1:3], 16), int(hex[3:5], 16), int(hex[5:7], 16), 255))
        made = []
        for index, (vertices, triangles) in enumerate(pieces):
            one = model.AddMeshObject()
            one.SetName(name if len(pieces) == 1 else f"{name} {index + 1}")
            positions = np.ascontiguousarray(vertices, dtype="<f4")
            indices = np.ascontiguousarray(triangles, dtype="<u4")
            wrapper.checkError(
                one,
                wrapper.lib.lib3mf_meshobject_setgeometry(
                    one._handle,
                    ctypes.c_uint64(len(positions)),
                    (Lib3MF.Position * len(positions)).from_buffer_copy(positions.tobytes()),
                    ctypes.c_uint64(len(indices)),
                    (Lib3MF.Triangle * len(indices)).from_buffer_copy(indices.tobytes()),
                ),
            )
            if color is not None:
                one.SetObjectLevelProperty(materials.GetResourceID(), color)
            made.append(one)
        whole = made[0]
        if len(made) > 1:
            whole = model.AddComponentsObject()
            whole.SetName(name)
            for one in made:
                whole.AddComponent(one, wrapper.GetIdentityTransform())
        # Where the layout has it: the vertices are in the object frame already.
        model.AddBuildItem(whole, wrapper.GetIdentityTransform())
    writer = model.QueryWriter("3mf")
    needed = ctypes.c_uint64(0)
    wrapper.checkError(writer, wrapper.lib.lib3mf_writer_writetobuffer(writer._handle, ctypes.c_uint64(0), needed, None))
    data = (ctypes.c_uint8 * needed.value)()
    wrapper.checkError(writer, wrapper.lib.lib3mf_writer_writetobuffer(writer._handle, ctypes.c_uint64(needed.value), needed, data))
    return bytes(data)


def _lib3mf() -> Any:
    import lib3mf
    from lib3mf import Lib3MF

    return Lib3MF.Wrapper(os.path.join(os.path.dirname(lib3mf.__file__), "lib3mf"))


Pieces = list[tuple[np.ndarray, np.ndarray]]


def _read_stl(path: str) -> list[tuple[str | None, Pieces]]:
    data = _bytes_of(path)
    if len(data) < 84:
        raise _Unread(f"the file is {len(data)} bytes: shorter than the header of an STL, so it was cut short")
    (count,) = struct.unpack_from("<I", data, 80)
    if len(data) != 84 + 50 * count:
        raise _Unread(
            f"the file says it has {count:,} triangles and holds {(len(data) - 84) / 50:,.1f}: it was cut short or is not a binary STL"
        )
    rows = np.frombuffer(data, dtype=STL_TRIANGLE, count=count, offset=84)
    vertices = rows["corners"].reshape(-1, 3).astype(np.float64)
    return [(None, [(vertices, np.arange(len(vertices), dtype=np.int64).reshape(-1, 3))])]


def _read_3mf(path: str) -> list[tuple[str | None, Pieces]]:
    """What a slicer puts on the plate: each build item, its name and its meshes where its transforms put them."""
    from lib3mf import Lib3MF

    if not Path(path).is_file():
        raise _Unread(f"there is no file at {path} to read back")
    wrapper = _lib3mf()
    model = wrapper.CreateModel()
    try:
        model.QueryReader("3mf").ReadFromFile(path)
    except Exception as e:
        raise _Unread(f"the file could not be read back as 3MF: {str(e) or type(e).__name__}") from None
    if model.GetUnit() != Lib3MF.ModelUnit.MilliMeter:
        raise _Unread(f"read back, its unit is {model.GetUnit().name}, not the millimetre")
    meshes: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    found = model.GetMeshObjects()
    while found.MoveNext():
        one = found.GetCurrentMeshObject()
        n, m = one.GetVertexCount(), one.GetTriangleCount()
        positions, indices, needed = (Lib3MF.Position * n)(), (Lib3MF.Triangle * m)(), ctypes.c_uint64(0)
        wrapper.checkError(one, wrapper.lib.lib3mf_meshobject_getvertices(one._handle, ctypes.c_uint64(n), needed, positions))
        wrapper.checkError(one, wrapper.lib.lib3mf_meshobject_gettriangleindices(one._handle, ctypes.c_uint64(m), needed, indices))
        vertices = np.frombuffer(positions, dtype="<f4").reshape(-1, 3).astype(np.float64)
        triangles = np.frombuffer(indices, dtype="<u4").reshape(-1, 3).astype(np.int64)
        if len(triangles) and int(triangles.max()) >= len(vertices):
            raise _Unread(f"read back, {one.GetName()!r} has a triangle with a corner it does not have")
        meshes[one.GetResourceID()] = (vertices, triangles)

    def moved(pieces: Pieces, transform: Any) -> Pieces:
        fields = np.array([list(row) for row in transform.Fields], dtype=np.float64)
        return [(vertices @ fields[:3] + fields[3], triangles) for vertices, triangles in pieces]

    placed: list[tuple[str | None, Pieces]] = []
    items = model.GetBuildItems()
    while items.MoveNext():
        item = items.GetCurrent()
        resource = item.GetObjectResourceID()
        thing = item.GetObjectResource()
        if resource in meshes:
            pieces = [meshes[resource]]
        elif thing.IsComponentsObject():
            whole = model.GetComponentsObjectByID(resource)
            pieces = []
            for i in range(whole.GetComponentCount()):
                component = whole.GetComponent(i)
                if component.GetObjectResourceID() not in meshes:
                    raise _Unread(f"read back, {whole.GetName()!r} is made of what is no mesh")
                pieces += moved([meshes[component.GetObjectResourceID()]], component.GetTransform())
        else:
            raise _Unread("read back, a build item is of no mesh in the file")
        placed.append((thing.GetName(), moved(pieces, item.GetObjectTransform())))
    return placed


def _bytes_of(path: str) -> bytes:
    try:
        return Path(path).read_bytes()
    except OSError as e:
        raise _Unread(f"the file could not be read back: {e.strerror or e}") from None


def _check_mesh(shapes: dict[str, Any], asked: dict[str, Any], path: str, held: dict[Any, Any]) -> dict[str, Any]:
    format, layout, parts, tolerance = asked["format"], asked["layout"], asked["parts"], asked["tolerance"]
    read = _read_stl(path) if format == "stl" else _read_3mf(path)
    problems: list[str] = []
    if format == "stl":
        named = [(parts[0], pieces) for _, pieces in read]
    else:
        names = [name for name, _ in read]
        if names != parts:
            problems.append(
                "read back, it holds "
                + (", ".join(repr(name) for name in names) or "no object")
                + " where it should hold "
                + ", ".join(repr(part) for part in parts)
            )
        named = [(name, pieces) for name, pieces in read if name in parts]
    objects = []
    for name, pieces in named:
        key = f"{layout}:{name}"
        shape = shapes[key]
        drawn = held.get(("deflection", key))
        if drawn is None:
            drawn = tess.deflection(shape)
        if len(pieces) == 1:
            low, high = box_of(shape, key, held)
            whole = (volume_of(shape, key, held), (low, high), boxed_exactly_of(shape, key, held), len(topo.shells(shape)))
            told, wrong = _mesh_verdict(name, *pieces[0], whole, tolerance, drawn)
            objects.append(told)
            problems.extend(wrong)
            continue
        solids = topo.solids(shape)
        if len(pieces) != len(solids):
            problems.append(f"{name}: read back it is {len(pieces)} meshes, and the part has {len(solids)} solids")
            continue
        # A mesh of each solid, held against that solid.
        for index, (piece, solid) in enumerate(zip(pieces, solids, strict=True)):
            one = (extent.volume(solid), extent.box(solid), extent.boxed_exactly(solid), len(topo.shells(solid)))
            told, wrong = _mesh_verdict(f"{name}, solid {index + 1}", *piece, one, tolerance, drawn)
            objects.append({**told, "part": name})
            problems.extend(wrong)
    triangles = sum(len(t) for _, pieces in read for _, t in pieces)
    return {"objects": objects, "problems": problems, "triangles": triangles}


def _mesh_verdict(
    name: str,
    vertices: np.ndarray,
    triangles: np.ndarray,
    of: tuple[extent.Volume, tuple[list[float], list[float]], bool, int],
    tolerance: float,
    drawn: float,
) -> tuple[dict[str, Any], list[str]]:
    """What a mesh read back is, held against what it is of (a part, or a solid of one: its volume, its box,
    whether that box is exact, its shells; ``drawn`` the deflection the part is drawn at), and what is wrong with
    it, a sentence each."""
    model, (model_low, model_high), exact_box, shells = of
    problems: list[str] = []
    told: dict[str, Any] = {"name": name, "triangles": len(triangles)}
    if len(triangles) == 0:
        return {**told, "volumeDeviation": None}, [f"{name}: read back it has no triangles"]
    _, welded = np.unique(checks.welded(vertices), return_inverse=True)
    welded = welded.reshape(-1)
    corners = welded[triangles]
    a, b, c = vertices[triangles[:, 0]], vertices[triangles[:, 1]], vertices[triangles[:, 2]]
    areas = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    distinct = (corners[:, 0] != corners[:, 1]) & (corners[:, 1] != corners[:, 2]) & (corners[:, 2] != corners[:, 0])
    degenerate = int(np.count_nonzero(~distinct | (areas < NO_AREA)))
    kept = corners[distinct]
    sides = np.concatenate([kept[:, [0, 1]], kept[:, [1, 2]], kept[:, [2, 0]]])
    _, uses = np.unique(np.sort(sides, axis=1), axis=0, return_counts=True)
    _, ways = np.unique(sides, axis=0, return_counts=True)
    open_edges = int(np.count_nonzero(uses == 1))
    shared = int(np.count_nonzero(uses > 2))
    # A side gone along twice the same way is between two triangles that face opposite ways.
    flipped = int(np.count_nonzero(ways > 1))
    pieces = _pieces(kept, int(welded.max()) + 1)
    enclosed = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6
    area = float(areas.sum())
    deviation = _percent(abs(enclosed), model.value)
    allowed = tess.MESH_SLACK * tolerance * area + model.spread + 1e-9 * model.value
    low, high = vertices.min(axis=0).tolist(), vertices.max(axis=0).tolist()
    slack = tess.MESH_SLACK * (tolerance + (0.0 if exact_box else drawn)) + checks.WELD
    boxed = all(abs(x - y) <= slack for x, y in zip([*low, *high], [*model_low, *model_high], strict=True))
    told.update(
        {
            "openEdges": open_edges,
            "sharedEdges": shared,
            "flipped": flipped,
            "degenerate": degenerate,
            "pieces": pieces,
            "shells": shells,
            "volume": abs(enclosed),
            "modelVolume": model.value,
            "volumeDeviation": deviation,
            "volumeAllowed": _percent(model.value + allowed, model.value),
            "box": {"min": low, "max": high},
        }
    )
    if open_edges:
        problems.append(f"{name}: {open_edges:,} sides of its triangles are of no other triangle: it is not closed")
    if shared:
        problems.append(f"{name}: {shared:,} sides of its triangles are of three triangles or more")
    if flipped:
        problems.append(f"{name}: {flipped:,} of its triangles face the other way from their neighbours")
    if degenerate:
        problems.append(f"{name}: {degenerate:,} of its triangles have no area")
    if pieces != shells:
        problems.append(f"{name}: it is in {pieces} pieces, and the part has {shells} {'shell' if shells == 1 else 'shells'}")
    if enclosed <= 0:
        problems.append(f"{name}: it is inside out: what it encloses is {enclosed:.6g} mm³")
    elif abs(enclosed - model.value) > allowed:
        problems.append(
            f"{name}: its volume is {deviation:.3g} % from the model's, more than the {tolerance:g} mm tolerance allows"
        )
    if not boxed:
        problems.append(f"{name}: its box is not the part's where the layout has it")
    return told, problems


def _pieces(triangles: np.ndarray, vertices: int) -> int:
    """How many pieces a mesh is in: triangles are of one piece when they share a corner."""
    if len(triangles) == 0:
        return 0
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    rows = np.concatenate([triangles[:, 0], triangles[:, 1]])
    cols = np.concatenate([triangles[:, 1], triangles[:, 2]])
    graph = coo_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(vertices, vertices))
    _, labels = connected_components(graph, directed=False)
    return len(np.unique(labels[np.unique(triangles)]))


def _percent(value: float, of: float) -> float | None:
    """How far ``value`` is from ``of``, in percent of it: None of nothing, which no percent is of."""
    return abs(value - of) / of * 100 if of > 0 else None
