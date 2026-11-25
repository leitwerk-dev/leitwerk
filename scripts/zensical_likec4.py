"""Render LikeC4 views inline in Zensical pages.

Zensical resolves `pymdownx.superfences` custom fence formatters by dotted
path, so `fence_format` is referenced from zensical.toml. `build_docs.py`
generates the web component bundle and validates referenced view ids.
"""

from __future__ import annotations

import hashlib
from html import escape
from pathlib import Path
import re
import subprocess

FENCE_NAME = "likec4-view"

_VIEW_ID_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_VIEW_DECL_RE = re.compile(
    r"^\s*(?:deployment\s+|dynamic\s+)?view\s+([A-Za-z_][A-Za-z0-9_]*)\b",
    re.MULTILINE,
)
_FENCE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<fence>`{3,}|~{3,})[ \t]*" + re.escape(FENCE_NAME) + r"[^\n]*\n"
    r"(?P<body>.*?)^(?P=indent)(?P=fence)[ \t]*$",
    re.MULTILINE | re.DOTALL,
)
_LINE_COMMENT_RE = re.compile(r"//[^\n]*")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def parse_view_id(source: str) -> str:
    view_id = source.strip()
    if not _VIEW_ID_RE.match(view_id):
        raise ValueError(f"Invalid LikeC4 view id in ```{FENCE_NAME} fence: {view_id!r}")
    return view_id


def fence_format(source, language, css_class, options, md, **kwargs) -> str:  # noqa: ARG001
    """Superfences formatter: turn a view id into a <likec4-view> element."""
    view_id = escape(parse_view_id(source), quote=True)
    return f'<likec4-view class="{FENCE_NAME}" view-id="{view_id}" browser="true"></likec4-view>'


def discover_view_ids(workspace: Path) -> set[str]:
    """Return the view ids declared in a LikeC4 workspace."""
    ids: set[str] = set()
    for path in sorted(workspace.rglob("*.c4")):
        text = path.read_text(encoding="utf-8")
        text = _LINE_COMMENT_RE.sub("", _BLOCK_COMMENT_RE.sub("", text))
        ids.update(_VIEW_DECL_RE.findall(text))
    return ids


def referenced_view_ids(markdown: str) -> list[str]:
    """Return the view ids referenced by likec4-view fences in a Markdown page."""
    return [match.group("body").strip() for match in _FENCE_RE.finditer(markdown)]


def _workspace_digest(workspace: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(workspace.rglob("*.c4")):
        digest.update(path.relative_to(workspace).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:16]


def generate_bundle(repo_root: Path, workspace: Path, cache_dir: Path) -> bytes:
    """Generate (or reuse) the LikeC4 web component bundle for a workspace."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    bundle = cache_dir / f"likec4-views-{_workspace_digest(workspace)}.js"
    if bundle.is_file():
        return bundle.read_bytes()

    likec4 = repo_root / "node_modules" / ".bin" / "likec4"
    if not likec4.is_file():
        raise FileNotFoundError("likec4 CLI not found. Install Node dependencies with: npm ci")
    tmp = cache_dir / f"pending-{bundle.name}"
    result = subprocess.run(
        [str(likec4), "codegen", "webcomponent", str(workspace), "-o", str(tmp)],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"likec4 codegen webcomponent failed:\n{result.stdout}{result.stderr}")
    for stale in cache_dir.glob("likec4-views-*.js"):
        stale.unlink()
    tmp.replace(bundle)
    return bundle.read_bytes()
