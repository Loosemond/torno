"""Find an object's model file, import it and collect its scene."""

import ast
import importlib.util
import inspect
import io
import math
import re
import sys
import tokenize
import traceback as tb_module
from pathlib import Path
from types import ModuleType, TracebackType
from typing import Any

_PRINT_FUNCTIONS = ("printables", "printable")
_MAKER_PREFIX = "make_"


class LoadError(Exception):
    """A model could not be found or loaded. ``kind`` is a protocol error kind."""

    def __init__(self, kind: str, message: str, traceback: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.traceback = traceback


def choose_model(dir: Path) -> Path:
    """Return the model file of an object folder.

    Candidates are the top-level ``*.py`` files that are not tests, dotfiles
    or ``__init__.py``. Of several, the one named after the folder is the
    model, with ``-`` and ``_`` treated alike (``helmet-stand/helmet_stand.py``).
    The app's ``scanWorkspace`` chooses by the same rule.
    """
    candidates = sorted(p for p in dir.glob("*.py") if p.is_file() and _is_candidate(p.name))
    if not candidates:
        raise LoadError("no_model", f"no model file in {dir}")
    if len(candidates) == 1:
        return candidates[0]
    named = [p for p in candidates if _same_name(p.stem, dir.name)]
    if len(named) == 1:
        return named[0]
    names = ", ".join(p.name for p in candidates)
    raise LoadError("no_model", f"more than one model file in {dir}: {names}")


class Layouts(dict):  # type: ignore[type-arg]
    """The layouts of a scene, layout → name → shape, and the tags the model gave their parts (``_tags``)."""

    tags: dict[tuple[str, str], dict[str, dict[str, list[int]]]]


def load_scene(dir: Path, model: str) -> dict[str, dict[str, Any]]:
    """Import ``dir/model`` and return its scene as layout → name → shape."""
    return load_model(dir, model)[0]


def load_model(
    dir: Path, model: str
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Import ``dir/model``: its scene as layout → name → shape, its ``Params`` (``read_params``), its
    groups of parts (``_groups``) and the checks it declares (``_checks``)."""
    path = (Path(dir) / model).resolve()
    try:
        module = _import_model(path)
        scene = _collect_scene(module)
        groups = _groups(module, scene) if scene else []
        checks = _checks(module, scene, groups) if scene else []
        scene = Layouts(scene)
        scene.tags = _tags(module, scene) if scene else {}
    except LoadError:
        raise
    except Exception as e:
        raise LoadError("exception", str(e), _model_traceback(e, path)) from e
    if not scene:
        raise LoadError("no_scene", _no_scene(module, model))
    return scene, read_params(module, path), groups, checks


_NOT_USES = {".venv", "venv", "site-packages", "__pycache__", ".torno", "node_modules", ".git"}


def used_files(dir: Path, model: str) -> list[str]:
    """The Python files of the workspace that the model imported, outside its own folder: another project's
    module, ``common/``. Paths relative to the workspace (the folder above ``dir``), with ``/``, in order.

    Read from ``sys.modules`` after the load, so it is what the model really imported, never what torno
    declares. The model itself, build123d and the standard library are not among them. A project that
    imports another which imports it back is listed by both: Python alone decides if that works.
    """
    own = (Path(dir) / model).resolve().parent
    root = own.parent
    found: set[str] = set()
    for name, module in list(sys.modules.items()):
        if name.startswith("torno_model_"):  # a model loaded as a model (a test process loads many), not imported
            continue
        file = getattr(module, "__file__", None)
        if not isinstance(file, str) or not file.endswith(".py"):
            continue
        try:
            path = Path(file).resolve()
            relative = path.relative_to(root)
        except (OSError, ValueError):
            continue
        if own in path.parents or _NOT_USES.intersection(relative.parts):
            continue
        found.add(relative.as_posix())
    return sorted(found)


_MARK_ID = re.compile(r"M\d+")


def _groups(module: ModuleType, scene: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """The model's ``groups(p)``: group name → part names, one level, a part in one group at most.

    Read only under the ``Params`` convention (``assembly``/``printables``/``make_<part>``); ``[]`` without it.
    A group is across layouts, by part name. What is wrong with it fails the build, saying how.
    """
    function = getattr(module, "groups", None)
    if not callable(function) or not hasattr(module, "Params"):
        return []
    made = function(module.Params())
    shape = "groups() must return a dict of group name to part names"
    if not isinstance(made, dict):
        raise LoadError("exception", f"{shape}, got {type(made).__name__}")
    parts = {name for layout in scene.values() for name in layout}
    known = ", ".join(dict.fromkeys(name for layout in scene.values() for name in layout))
    owner: dict[str, str] = {}
    groups: list[dict[str, Any]] = []
    for name, members in made.items():
        if not isinstance(name, str) or not isinstance(members, (list, tuple)):
            raise LoadError("exception", f"{shape}, got {name!r}: {type(members).__name__}")
        if not all(isinstance(m, str) for m in members):
            raise LoadError("exception", f"{shape}: group {name} holds something that is not a part name")
        if not name:
            raise LoadError("exception", "groups(): a group name is not empty")
        if "/" in name:
            raise LoadError("exception", f"groups(): a group name has no /: {name}")
        if _MARK_ID.fullmatch(name):
            raise LoadError("exception", f"groups(): group {name} has the form of a mark's id; name it otherwise")
        if name in parts:
            raise LoadError("exception", f"groups(): group {name} has the name of a part; name it otherwise")
        if not members:
            raise LoadError("exception", f"groups(): group {name} has no parts")
        for member in members:
            if member not in parts:
                raise LoadError("exception", f"groups() names {member}, which no layout has; parts: {known}")
            if member in owner and owner[member] != name:
                raise LoadError(
                    "exception", f"groups(): {member} is in groups {owner[member]} and {name}; a part is in one at most"
                )
            owner[member] = name
        groups.append({"name": name, "parts": list(dict.fromkeys(members))})
    return groups


_TAG_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]*")


def _tags(module: ModuleType, scene: dict[str, dict[str, Any]]) -> dict[tuple[str, str], dict[str, dict[str, list[int]]]]:
    """The model's ``tags(p, parts)``: part → tag → a face, an edge, or a list of them, taken from the shapes it
    was given. Called once per layout with that layout's parts, read only under the ``Params`` convention.

    Each face or edge is matched to the kernel's index (``topo``) by ``IsSame``, here, before the build spreads a
    print layout (a moved shape is not the same one). Returns ``(layout, part) → tag → {"faces": [...], "edges":
    [...]}``, the empty lists left out and the indices in the order given. A tag that names nothing the part has
    (a shape of another part, a solid, an empty list), a name that is no tag name, or a part no layout has fails
    the build, saying which.
    """
    function = getattr(module, "tags", None)
    if not callable(function) or not hasattr(module, "Params"):
        return {}
    from . import topo
    from .ocp import TopAbs_EDGE, TopAbs_FACE, TopExp, TopTools_IndexedMapOfShape

    shape = "tags() must return a dict of part name to a dict of tag name to a face, an edge or a list of them"
    params = module.Params()
    known = ", ".join(dict.fromkeys(name for layout in scene.values() for name in layout))
    found: dict[tuple[str, str], dict[str, dict[str, list[int]]]] = {}
    for layout, parts in scene.items():
        made = function(params, dict(parts))
        if not isinstance(made, dict):
            raise LoadError("exception", f"{shape}, got {type(made).__name__}")
        for part, named in made.items():
            if not isinstance(part, str) or not isinstance(named, dict):
                raise LoadError("exception", f"{shape}, got {part!r}: {type(named).__name__}")
            if part not in parts:
                if any(part in other for other in scene.values()):
                    continue  # a part the model keeps out of this layout
                raise LoadError("exception", f"tags() names {part}, which no layout has; parts: {known}")
            whole = getattr(parts[part], "wrapped", parts[part])
            maps = {}
            for kind in (TopAbs_FACE, TopAbs_EDGE):
                maps[kind] = TopTools_IndexedMapOfShape()
                TopExp.MapShapes_s(whole, kind, maps[kind])
            count = {"face": len(topo.faces(parts[part])), "edge": len(topo.edges(parts[part]))}
            tagged: dict[str, dict[str, list[int]]] = {}
            for tag, shapes in named.items():
                where = f"tags(): {part}/@{tag}"
                if not isinstance(tag, str) or not _TAG_NAME.fullmatch(tag):
                    raise LoadError(
                        "exception", f"tags(): {tag!r} is no tag name of {part}: a letter or _ first, then letters, digits, _ . -"
                    )
                items = list(shapes) if isinstance(shapes, (list, tuple)) else [shapes]
                if not items:
                    raise LoadError("exception", f"{where} is an empty list: it names no face or edge of {part}")
                indices: dict[str, list[int]] = {"faces": [], "edges": []}
                for item in items:
                    wrapped = getattr(item, "wrapped", None)
                    kind = wrapped.ShapeType() if wrapped is not None else None
                    if kind not in (TopAbs_FACE, TopAbs_EDGE):
                        raise LoadError("exception", f"{where} is {type(item).__name__}, not a face or an edge of {part}")
                    what = "face" if kind == TopAbs_FACE else "edge"
                    number = maps[kind].FindIndex(wrapped) - 1
                    if number < 0:
                        raise LoadError(
                            "exception",
                            f"{where} is a {what} that {part} does not have (the tag is stale: it was taken from another "
                            f"shape, or from {part} before it was changed); {part} has {count[what]} {what}s",
                        )
                    if number not in indices[what + "s"]:
                        indices[what + "s"].append(number)
                tagged[tag] = {side: numbers for side, numbers in indices.items() if numbers}
            if tagged:
                found[(layout, part)] = tagged
    return found


def _checks(module: ModuleType, scene: dict[str, dict[str, Any]], groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The model's ``checks(p)``: declarations in torno's vocabulary (``modelchecks``), read only under the
    ``Params`` convention; ``[]`` without it. Only their shape and the names they use are checked here: a
    malformed one fails the build, saying how. Measuring them is the worker's, once the build is tessellated."""
    function = getattr(module, "checks", None)
    if not callable(function) or not hasattr(module, "Params"):
        return []
    from . import modelchecks

    try:
        return modelchecks.validate(function(module.Params()), scene, groups)
    except modelchecks.Malformed as e:
        raise LoadError("exception", str(e)) from e


def read_params(module: ModuleType, path: Path) -> list[dict[str, Any]]:
    """The fields of the model's ``Params`` dataclass, in their order. Empty when it has none.

    Each is ``name``; ``type`` as written in the source (else as Python names
    it); ``default``, the value ``Params()`` holds, when it is a plain value
    JSON can say (a number, a string, a bool, None, or lists and dicts of
    them), else null; ``literal``, whether the default in the source is a
    literal (``2.5``, ``-2``, ``"tray"``, ``None``), not an expression nor a
    ``default_factory``; and ``doc``, the comment at the end of the field's
    line, else the comment lines right above it, else a string right below
    it, else null. Reading it never fails a build: what cannot be read is
    left out.
    """
    try:
        import dataclasses

        params = getattr(module, "Params", None)
        if not (isinstance(params, type) and dataclasses.is_dataclass(params)):
            return []
        try:
            made = params()
        except Exception:
            made = None
        written = _written_fields(path)
        told = []
        for field in dataclasses.fields(params):
            if not field.init:
                continue
            source = written.get(field.name, {})
            value = getattr(made, field.name, None) if made is not None else None
            told.append(
                {
                    "name": field.name,
                    "type": source.get("type") or _type_name(field.type),
                    "default": value if _plain(value) else None,
                    "literal": bool(source.get("literal", False)),
                    "doc": source.get("doc"),
                }
            )
        return told
    except Exception:
        return []


def _type_name(type: Any) -> str:
    return type if isinstance(type, str) else getattr(type, "__name__", None) or repr(type)


def _plain(value: Any, depth: int = 0) -> bool:
    """Whether JSON says ``value`` as it is: a NaN or an infinity it cannot."""
    if depth > 8:
        return False
    if value is None or isinstance(value, (bool, int, str)):
        return not isinstance(value, int) or isinstance(value, bool) or abs(value) < 2**63
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, (list, tuple)):
        return len(value) <= 1000 and all(_plain(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return len(value) <= 1000 and all(isinstance(k, str) and _plain(v, depth + 1) for k, v in value.items())
    return False


def _written_fields(path: Path) -> dict[str, dict[str, Any]]:
    """What the source says of each field of the top-level ``class Params``: type, literal, doc."""
    text = path.read_text(encoding="utf-8")
    tree = ast.parse(text)
    lines = text.splitlines()
    comments: dict[int, str] = {}
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT:
            comments[token.start[0]] = token.string.lstrip("#").strip()
    found: dict[str, dict[str, Any]] = {}
    for node in tree.body:
        if not (isinstance(node, ast.ClassDef) and node.name == "Params"):
            continue
        body = node.body
        for i, statement in enumerate(body):
            if not (isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name)):
                continue
            following = body[i + 1] if i + 1 < len(body) else None
            found[statement.target.id] = {
                "type": ast.unparse(statement.annotation),
                "literal": _literal(statement.value),
                "doc": _doc(statement, following, comments, lines),
            }
    return found


def _literal(value: ast.expr | None) -> bool:
    if value is None:
        return False
    if isinstance(value, ast.Call) and getattr(value.func, "id", getattr(value.func, "attr", None)) == "field":
        given = {k.arg: k.value for k in value.keywords}
        return "default" in given and _literal(given["default"])
    try:
        ast.literal_eval(value)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return False
    return True


def _doc(statement: ast.stmt, following: ast.stmt | None, comments: dict[int, str], lines: list[str]) -> str | None:
    end = statement.end_lineno or statement.lineno
    if comments.get(end):
        return comments[end]
    above = []
    line = statement.lineno - 1
    while line >= 1 and lines[line - 1].strip().startswith("#"):
        above.insert(0, comments.get(line, ""))
        line -= 1
    said = " ".join(part for part in above if part)
    if said:
        return said
    if (
        isinstance(following, ast.Expr)
        and isinstance(following.value, ast.Constant)
        and isinstance(following.value.value, str)
    ):
        return inspect.cleandoc(following.value.value) or None
    return None


def _is_candidate(name: str) -> bool:
    return not (name.startswith(".") or name == "__init__.py" or _is_test_file(name))


def _same_name(a: str, b: str) -> bool:
    return a.replace("-", "_") == b.replace("-", "_")


def _is_test_file(name: str) -> bool:
    return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"


def _import_model(path: Path) -> ModuleType:
    """Import the file as a module, so its ``__main__`` block does not run."""
    sys.path.insert(0, str(path.parent))
    name = f"torno_model_{path.stem}"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses look the module up while it executes
    spec.loader.exec_module(module)
    return module


def _collect_scene(module: ModuleType) -> dict[str, dict[str, Any]]:
    """The model's layouts, by the first convention it follows.

    ``Params`` with ``assembly(p)`` or ``printables(p)``; else ``Params`` with
    ``make_<part>(p)`` functions, as the layout ``main``; else its top-level
    shapes, as ``main`` too.
    """
    print_function = next((f for f in _PRINT_FUNCTIONS if hasattr(module, f)), None)
    has_assembly = hasattr(module, "assembly")
    layouts: dict[str, dict[str, Any]] = {}
    if hasattr(module, "Params") and (has_assembly or print_function):
        params = module.Params()
        if has_assembly:
            layouts["assembly"] = _parts(module.assembly(params), "assembly")
        if print_function:
            layouts["print"] = _parts(getattr(module, print_function)(params), print_function)
    else:
        if hasattr(module, "Params"):
            layouts["main"] = _made_parts(module)
        if not layouts.get("main"):
            layouts["main"] = _top_level_shapes(module)
    return {layout: parts for layout, parts in layouts.items() if parts}


def _makers(module: ModuleType) -> dict[str, Any]:
    """The model's own ``make_<part>`` functions that take the parameters alone, by part name."""
    makers = {}
    for name, value in vars(module).items():
        if not name.startswith(_MAKER_PREFIX) or name == _MAKER_PREFIX:
            continue
        # Its own: a maker imported from a library is a tool of the model, not a part of it.
        if not inspect.isfunction(value) or value.__module__ != module.__name__:
            continue
        if _takes_one_argument(value):
            makers[name.removeprefix(_MAKER_PREFIX)] = value
    return makers


def _takes_one_argument(function: Any) -> bool:
    """Whether ``function(p)`` is a complete call: one required parameter, a positional one."""
    try:
        parameters = inspect.signature(function).parameters.values()
    except (TypeError, ValueError):
        return False
    required = [
        p
        for p in parameters
        if p.default is p.empty and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
    ]
    return len(required) == 1 and required[0].kind is not required[0].KEYWORD_ONLY


def _made_parts(module: ModuleType) -> dict[str, Any]:
    """Call every maker with ``Params()`` and keep what comes back as a solid shape."""
    makers = _makers(module)
    if not makers:
        return {}
    params = module.Params()
    made = {name: maker(params) for name, maker in makers.items()}
    return {name: value for name, value in made.items() if _is_solid_shape(value)}


def _no_scene(module: ModuleType, model: str) -> str:
    """Say what was looked for, and what stood in the way of what was found."""
    found = [f"{name}(p)" for name in ("assembly", *_PRINT_FUNCTIONS) if hasattr(module, name)]
    found += [f"{_MAKER_PREFIX}{name}(p)" for name in _makers(module)]
    if found and not hasattr(module, "Params"):
        them = "it" if len(found) == 1 else "them"
        return (
            f"{model} defines {_and(found)} but no Params class to call {them} with, "
            "and no top-level shapes"
        )
    return f"{model} defines no assembly(p), printables(p), make_<part>(p) or top-level shapes"


def _and(names: list[str]) -> str:
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def _parts(result: Any, function: str) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise LoadError(
            "exception",
            f"{function}() must return a dict of name to shape, got {type(result).__name__}",
        )
    return dict(result)


def _top_level_shapes(module: ModuleType) -> dict[str, Any]:
    return {
        name: value
        for name, value in vars(module).items()
        if not name.startswith("_") and _is_solid_shape(value)
    }


def _is_solid_shape(value: Any) -> bool:
    # build123d comes from the user's workspace, so it is imported only here.
    from build123d import Shape

    return isinstance(value, Shape) and bool(value.solids())


def _model_traceback(e: BaseException, path: Path) -> str:
    """Format the traceback from the first frame in the model file onward."""
    tb: TracebackType | None = e.__traceback__
    while tb is not None and Path(tb.tb_frame.f_code.co_filename) != path:
        tb = tb.tb_next
    return "".join(tb_module.format_exception(type(e), e, tb))
