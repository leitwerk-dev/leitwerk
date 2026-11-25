"""Generate LikeC4 assets and render view fences in Zensical."""

from functools import cache
import json
from pathlib import Path
import re
import subprocess

from pymdownx.superfences import SuperFencesException

MODEL_NAME = "likec4-model.json"


@cache
def _view_ids() -> set[str]:
    model = Path(MODEL_NAME)
    return set(json.loads(model.read_text(encoding="utf-8"))["views"]) if model.is_file() else set()


def fence_format(source, language, css_class, options, md, **kwargs) -> str:  # noqa: ARG001
    view_id = source.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", view_id):
        raise SuperFencesException(f"Invalid LikeC4 view id: {view_id!r}")
    if view_id not in _view_ids():
        raise SuperFencesException(f"Unknown LikeC4 view {view_id!r}")
    return f'<likec4-view class="likec4-view" view-id="{view_id}" browser="true"></likec4-view>'


def generate(repo_root: Path, workspace: Path, staging_dir: Path, bundle: Path) -> None:
    likec4 = repo_root / "node_modules" / ".bin" / "likec4"
    if not likec4.is_file():
        raise FileNotFoundError("LikeC4 CLI not found. Install Node dependencies with: npm ci")
    bundle.parent.mkdir(parents=True, exist_ok=True)
    for args in (
        ("export", "json", "--skip-layout", "-o", staging_dir / MODEL_NAME),
        ("codegen", "webcomponent", "-o", bundle),
    ):
        subprocess.run([likec4, *args, workspace], cwd=repo_root, check=True)
