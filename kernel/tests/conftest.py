from pathlib import Path

import pytest


@pytest.fixture
def ws() -> Path:
    """The fixture workspace: one object folder per loading case."""
    return Path(__file__).parent / "fixtures" / "ws"
