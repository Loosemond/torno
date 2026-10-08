"""Find an object's model file, import it and collect its scene."""

import importlib.util
import sys
import traceback as tb_module
from pathlib import Path
from types import ModuleType, TracebackType
from typing import Any

_PRINT_FUNCTIONS = ("printables", "printable")


class LoadError(Exception):
    """A model could not be found or loaded. ``kind`` is a protocol error kind."""

    def __init__(self, kind: str, message: str, traceback: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.traceback = traceback


def choose_model(dir: Path) -> Path:
    """Return the one model file in an object folder.

    Candidates are the top-level ``*.py`` files that are not tests.
    """
    candidates = sorted(p for p in dir.glob("*.py") if p.is_file() and not _is_test_file(p.name))
    if not candidates:
        raise LoadError("no_model", f"no model file in {dir}")
    if len(candidates) > 1:
        names = ", ".join(p.name for p in candidates)
        raise LoadError("no_model", f"more than one model file in {dir}: {names}")
    return candidates[0]


def load_scene(dir: Path, model: str) -> dict[str, dict[str, Any]]:
    """Import ``dir/model`` and return its scene as layout → name → shape."""
    path = (Path(dir) / model).resolve()
    try:
        module = _import_model(path)
        scene = _collect_scene(module)
    except LoadError:
        raise
    except Exception as e:
        raise LoadError("exception", str(e), _model_traceback(e, path)) from e
    if not scene:
        raise LoadError(
            "no_scene", f"{model} defines no assembly(), printables() or top-level shapes"
        )
    return scene


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
    """Layouts by convention if the model follows it, else its top-level shapes."""
    print_function = next((f for f in _PRINT_FUNCTIONS if hasattr(module, f)), None)
    has_assembly = hasattr(module, "assembly")
    if hasattr(module, "Params") and (has_assembly or print_function):
        params = module.Params()
        layouts = {}
        if has_assembly:
            layouts["assembly"] = _parts(module.assembly(params), "assembly")
        if print_function:
            layouts["print"] = _parts(getattr(module, print_function)(params), print_function)
    else:
        layouts = {"main": _top_level_shapes(module)}
    return {layout: parts for layout, parts in layouts.items() if parts}


def _parts(result: Any, function: str) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise LoadError(
            "exception",
            f"{function}() must return a dict of name to shape, got {type(result).__name__}",
        )
    return dict(result)


def _top_level_shapes(module: ModuleType) -> dict[str, Any]:
    # build123d comes from the user's workspace, so it is imported only here.
    from build123d import Shape

    return {
        name: value
        for name, value in vars(module).items()
        if not name.startswith("_") and isinstance(value, Shape) and value.solids()
    }


def _model_traceback(e: BaseException, path: Path) -> str:
    """Format the traceback from the first frame in the model file onward."""
    tb: TracebackType | None = e.__traceback__
    while tb is not None and Path(tb.tb_frame.f_code.co_filename) != path:
        tb = tb.tb_next
    return "".join(tb_module.format_exception(type(e), e, tb))
