import pytest

from torno_kernel.loader import LoadError, choose_model, load_scene


def test_bracket_gives_assembly_and_print_layouts(ws):
    scene = load_scene(ws / "bracket", "bracket.py")
    assert list(scene) == ["assembly", "print"]
    assert set(scene["assembly"]) == {"base", "post"}
    assert set(scene["print"]) == {"base", "post"}


def test_bracket_layouts_hold_the_shapes_the_model_returned(ws):
    scene = load_scene(ws / "bracket", "bracket.py")
    assert scene["assembly"]["base"].volume == pytest.approx(40 * 30 * 5)
    assert scene["assembly"]["post"].center().Z == pytest.approx(12.5)
    assert scene["print"]["post"].center().X == pytest.approx(60)


def test_model_is_imported_not_run_as_main(ws):
    # bracket.py raises SystemExit under `if __name__ == "__main__"`.
    load_scene(ws / "bracket", "bracket.py")


def test_plain_gives_main_layout_with_public_shapes_only(ws):
    scene = load_scene(ws / "plain", "plain.py")
    assert list(scene) == ["main"]
    assert list(scene["main"]) == ["plate"]


def test_chatty_loads_despite_printing(ws, capsys):
    scene = load_scene(ws / "chatty", "chatty.py")
    assert list(scene) == ["assembly"]
    assert list(scene["assembly"]) == ["plate"]
    assert capsys.readouterr().out == "report line\nreport line\n"


def test_broken_raises_exception_with_message_and_trimmed_traceback(ws):
    with pytest.raises(LoadError) as info:
        load_scene(ws / "broken", "broken.py")
    err = info.value
    assert err.kind == "exception"
    assert "wall too thin" in err.message
    assert "broken.py" in err.traceback
    assert "ValueError" in err.traceback
    assert "loader.py" not in err.traceback


def test_noscene_raises_no_scene_naming_what_was_looked_for(ws):
    with pytest.raises(LoadError) as info:
        load_scene(ws / "noscene", "noscene.py")
    assert info.value.kind == "no_scene"
    assert info.value.message == (
        "noscene.py defines no assembly(), printables() or top-level shapes"
    )
    assert info.value.traceback == ""


def test_choose_model_picks_the_model_and_ignores_tests(ws):
    assert choose_model(ws / "bracket") == ws / "bracket" / "bracket.py"


def test_choose_model_ignores_suffix_tests_and_conftest(tmp_path):
    for name in ("part.py", "part_test.py", "test_part.py", "conftest.py"):
        (tmp_path / name).write_text("")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "other.py").write_text("")
    assert choose_model(tmp_path) == tmp_path / "part.py"


def test_empty_folder_raises_no_model(ws):
    with pytest.raises(LoadError) as info:
        choose_model(ws / "empty")
    assert info.value.kind == "no_model"
    assert info.value.message == f"no model file in {ws / 'empty'}"


def test_two_candidates_raise_no_model_naming_them(ws):
    with pytest.raises(LoadError) as info:
        choose_model(ws / "two")
    assert info.value.kind == "no_model"
    assert "a.py" in info.value.message
    assert "b.py" in info.value.message
