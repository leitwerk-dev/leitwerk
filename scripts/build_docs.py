#!/usr/bin/env python3
"""Stage repository documentation and run Zensical build or serve."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time

import zensical_likec4

NAV_MARKER = "# __BUNDLED_EXTENSIONS_NAV__"
IGNORED_NAMES = {".DS_Store", "__pycache__"}
LIKEC4_WORKSPACE = Path("docs") / "maintainers" / "likec4"
LIKEC4_BUNDLE = Path("assets") / "javascripts" / "likec4-views.js"
LIKEC4_CACHE = Path(".zensical-cache") / "likec4"

_LINK_RE = re.compile(r"(\]\(|^\[[^\]]+\]:\s*)(<)?([^)\s>]+)(>)?", re.MULTILINE)


def _git_tracked_paths(repo_root: Path, patterns: list[str]) -> list[Path] | None:
    if not (repo_root / ".git").exists():
        return None
    try:
        result = subprocess.run(
            ["git", "ls-files", "--", *patterns],
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    paths: list[Path] = []
    for line in result.stdout.splitlines():
        rel = line.strip()
        if not rel:
            continue
        candidate = repo_root / rel
        if candidate.is_file():
            paths.append(candidate)
    return sorted(paths)


def discover_bundled_docs(repo_root: Path) -> tuple[list[tuple[str, list[Path]]], Path | None]:
    """Return sorted (extension_name, [files]) entries and optional packages/wiki/README.md."""
    tracked = _git_tracked_paths(
        repo_root,
        ["extensions/*/README.md", "extensions/*/*.mmd", "packages/wiki/README.md"],
    )
    if tracked is not None:
        ext_files: dict[str, list[Path]] = {}
        wiki_readme: Path | None = None
        for path in tracked:
            rel = path.relative_to(repo_root)
            parts = rel.parts
            if len(parts) == 3 and parts[0] == "extensions":
                ext_files.setdefault(parts[1], []).append(path)
            elif rel.as_posix() == "packages/wiki/README.md":
                wiki_readme = path
        extensions = [
            (name, sorted(files))
            for name, files in sorted(ext_files.items())
            if any(f.name == "README.md" for f in files)
        ]
        return extensions, wiki_readme

    extensions = []
    ext_root = repo_root / "extensions"
    if ext_root.is_dir():
        for ext_dir in sorted(p for p in ext_root.iterdir() if p.is_dir()):
            if ext_dir.name == "node_modules":
                continue
            readme = ext_dir / "README.md"
            if not readme.is_file():
                continue
            files = [readme, *sorted(ext_dir.glob("*.mmd"))]
            extensions.append((ext_dir.name, files))

    wiki_candidate = repo_root / "packages" / "wiki" / "README.md"
    wiki_readme = wiki_candidate if wiki_candidate.is_file() else None
    return extensions, wiki_readme


def rewrite_staged_links(markdown: str, kind: str) -> str:
    """Rewrite repository-relative links for READMEs staged under extensions/bundled/<name>/."""

    def _replace(match: re.Match[str]) -> str:
        prefix, open_angle, target, close_angle = match.groups()
        open_angle = open_angle or ""
        close_angle = close_angle or ""
        new_target = target
        if kind == "extension":
            if target.startswith("../../docs/"):
                new_target = "../../../" + target[len("../../docs/"):]
            elif target.startswith("../../packages/wiki/README.md"):
                new_target = "../wiki/README.md" + target[len("../../packages/wiki/README.md"):]
        elif kind == "wiki":
            if target.startswith("../../docs/"):
                new_target = "../../../" + target[len("../../docs/"):]
            elif target.startswith("../../extensions/"):
                new_target = "../" + target[len("../../extensions/"):]
        return f"{prefix}{open_angle}{new_target}{close_angle}"

    return _LINK_RE.sub(_replace, markdown)


def rewrite_doc_links(markdown: str, doc_rel_path: Path, repo_root: Path) -> str:
    """Rewrite repo-relative links in docs/**/*.md to staged extensions/bundled/ targets."""
    repo_root = repo_root.resolve()
    source_dir = (repo_root / "docs" / doc_rel_path).parent
    staged_dir = (Path("docs") / doc_rel_path).parent

    def _replace(match: re.Match[str]) -> str:
        prefix, open_angle, target, close_angle = match.groups()
        open_angle = open_angle or ""
        close_angle = close_angle or ""
        if (
            not target
            or target.startswith(("#", "/", "http://", "https://", "mailto:"))
            or "://" in target
        ):
            return match.group(0)

        path_part, sep, anchor = target.partition("#")
        if not path_part:
            return match.group(0)

        resolved = (source_dir / path_part).resolve()
        try:
            rel_repo = resolved.relative_to(repo_root)
        except ValueError:
            return match.group(0)

        parts = rel_repo.parts
        staged_target: Path | None = None
        if len(parts) == 3 and parts[0] == "extensions" and (
            parts[2] == "README.md" or parts[2].endswith(".mmd")
        ):
            staged_target = Path("docs") / "extensions" / "bundled" / parts[1] / parts[2]
        elif rel_repo.as_posix() == "packages/wiki/README.md":
            staged_target = Path("docs") / "extensions" / "bundled" / "wiki" / "README.md"

        if staged_target is None:
            return match.group(0)

        rel_link = Path(os.path.relpath(staged_target, staged_dir)).as_posix()
        new_target = f"{rel_link}{sep}{anchor}" if sep else rel_link
        return f"{prefix}{open_angle}{new_target}{close_angle}"

    return _LINK_RE.sub(_replace, markdown)


def _toml_str(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _format_bundled_nav(ext_names: list[str], has_wiki: bool) -> str:
    entries: list[str] = []
    for name in ext_names:
        entries.append(
            f'      {{ {_toml_str(name)} = {_toml_str(f"extensions/bundled/{name}/README.md")} }},'
        )
    if has_wiki:
        entries.append('      { "wiki (core package)" = "extensions/bundled/wiki/README.md" },')
    if not entries:
        return ""
    body = "\n".join(entries)
    return f'{{ "Built-in extensions" = [\n{body}\n    ] }},'


def _write_if_changed(dst: Path, content: bytes) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_file() and dst.read_bytes() == content:
        return
    dst.write_bytes(content)


def _add_likec4_bundle(repo_root: Path, desired: dict[Path, bytes]) -> None:
    """Validate likec4-view references and stage the LikeC4 web component bundle."""
    workspace = repo_root / LIKEC4_WORKSPACE
    known = zensical_likec4.discover_view_ids(workspace) if workspace.is_dir() else set()
    for rel, content in desired.items():
        if rel.suffix != ".md":
            continue
        for view_id in zensical_likec4.referenced_view_ids(content.decode("utf-8")):
            if view_id not in known:
                raise ValueError(
                    f"Unknown LikeC4 view {view_id!r} in {rel.as_posix()}; "
                    f"views are declared in {LIKEC4_WORKSPACE.as_posix()}/"
                )
    if workspace.is_dir():
        desired[LIKEC4_BUNDLE] = zensical_likec4.generate_bundle(
            repo_root, workspace, repo_root / LIKEC4_CACHE
        )


def _desired_staged_files(repo_root: Path) -> tuple[dict[Path, bytes], str]:
    """Compute desired staged docs files (relative to staged_docs) and zensical.toml text."""
    repo_root = repo_root.resolve()
    docs_root = repo_root / "docs"
    desired: dict[Path, bytes] = {}

    for src in sorted(docs_root.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(docs_root)
        if any(part in IGNORED_NAMES for part in rel.parts):
            continue
        if src.suffix == ".md":
            text = src.read_text(encoding="utf-8")
            rewritten = rewrite_doc_links(text, rel, repo_root)
            desired[rel] = rewritten.encode("utf-8")
        else:
            desired[rel] = src.read_bytes()

    extensions, wiki_readme = discover_bundled_docs(repo_root)
    for ext_name, files in extensions:
        for src_file in files:
            rel = Path("extensions") / "bundled" / ext_name / src_file.name
            if src_file.name == "README.md":
                text = src_file.read_text(encoding="utf-8")
                desired[rel] = rewrite_staged_links(text, "extension").encode("utf-8")
            else:
                desired[rel] = src_file.read_bytes()

    if wiki_readme is not None:
        rel = Path("extensions") / "bundled" / "wiki" / "README.md"
        text = wiki_readme.read_text(encoding="utf-8")
        desired[rel] = rewrite_staged_links(text, "wiki").encode("utf-8")

    _add_likec4_bundle(repo_root, desired)

    config_text = (repo_root / "zensical.toml").read_text(encoding="utf-8")
    if NAV_MARKER not in config_text:
        raise ValueError(f"Missing {NAV_MARKER} in zensical.toml")

    config_text = re.sub(
        r'^docs_dir\s*=\s*"[^"]*"',
        lambda _: 'docs_dir = "docs"',
        config_text,
        count=1,
        flags=re.MULTILINE,
    )
    config_text = re.sub(
        r'^site_dir\s*=\s*"[^"]*"',
        lambda _: 'site_dir = "site"',
        config_text,
        count=1,
        flags=re.MULTILINE,
    )
    config_text = re.sub(
        r"^base_path\s*=\s*\[[^\]]*\]",
        lambda _: f"base_path = [{_toml_str(repo_root.as_posix())}]",
        config_text,
        count=1,
        flags=re.MULTILINE,
    )

    bundled_nav = _format_bundled_nav([name for name, _ in extensions], wiki_readme is not None)
    config_text = config_text.replace(NAV_MARKER, bundled_nav, 1)
    return desired, config_text


def stage_docs(repo_root: Path, staging_dir: Path, clean: bool = True) -> Path:
    """Stage docs/, bundled extension READMEs, and generated zensical.toml."""
    repo_root = repo_root.resolve()
    staging_dir = staging_dir.resolve()
    staged_docs = staging_dir / "docs"

    if clean and staging_dir.exists():
        shutil.rmtree(staging_dir)
    staged_docs.mkdir(parents=True, exist_ok=True)

    desired, config_text = _desired_staged_files(repo_root)

    if not clean:
        for existing in sorted(staged_docs.rglob("*"), reverse=True):
            rel = existing.relative_to(staged_docs)
            if existing.is_file() and rel not in desired:
                existing.unlink()
            elif existing.is_dir() and not any(existing.iterdir()):
                existing.rmdir()

    for rel, content in desired.items():
        _write_if_changed(staged_docs / rel, content)

    staged_config = staging_dir / "zensical.toml"
    _write_if_changed(staged_config, config_text.encode("utf-8"))
    return staged_config


def _source_snapshot(repo_root: Path) -> dict[Path, int]:
    snapshot: dict[Path, int] = {}
    config = repo_root / "zensical.toml"
    if config.is_file():
        snapshot[config] = config.stat().st_mtime_ns
    docs_root = repo_root / "docs"
    if docs_root.is_dir():
        for src in docs_root.rglob("*"):
            if src.is_file() and not any(part in IGNORED_NAMES for part in src.parts):
                snapshot[src] = src.stat().st_mtime_ns
    extensions, wiki_readme = discover_bundled_docs(repo_root)
    for _, files in extensions:
        for src in files:
            if src.is_file():
                snapshot[src] = src.stat().st_mtime_ns
    if wiki_readme is not None and wiki_readme.is_file():
        snapshot[wiki_readme] = wiki_readme.stat().st_mtime_ns
    return snapshot


def _watch_and_restage(
    repo_root: Path,
    staging_dir: Path,
    stop_event: threading.Event,
    interval: float = 0.5,
) -> None:
    last = _source_snapshot(repo_root)
    while not stop_event.wait(interval):
        current = _source_snapshot(repo_root)
        if current != last:
            try:
                stage_docs(repo_root, staging_dir, clean=False)
            except Exception as exc:  # noqa: BLE001
                print(f"[build_docs] re-stage error: {exc}", file=sys.stderr)
            last = current


def find_zensical(repo_root: Path) -> str:
    """Locate the zensical binary in the active Python environment, .venv, or PATH."""
    interpreter_bin = Path(sys.executable).parent / "zensical"
    if interpreter_bin.is_file():
        return str(interpreter_bin)
    venv_bin = repo_root / ".venv" / "bin" / "zensical"
    if venv_bin.is_file():
        return str(venv_bin)
    found = shutil.which("zensical")
    if found:
        return found
    raise FileNotFoundError(
        "zensical executable not found. Install it with: pip install -r requirements-docs.txt"
    )


def _zensical_env() -> dict[str, str]:
    """Make scripts/ importable so zensical.toml can reference zensical_likec4."""
    scripts_dir = str(Path(__file__).resolve().parent)
    existing = os.environ.get("PYTHONPATH")
    return {
        **os.environ,
        "PYTHONPATH": f"{scripts_dir}{os.pathsep}{existing}" if existing else scripts_dir,
    }


def build_site(
    repo_root: Path,
    staging_dir: Path,
    site_dir: Path,
    strict: bool = False,
) -> int:
    """Stage docs, run zensical build inside staging_dir, and publish to site_dir."""
    staged_config = stage_docs(repo_root, staging_dir, clean=True)
    zensical = find_zensical(repo_root)
    cmd = [zensical, "build", "--clean", "-f", str(staged_config)]
    if strict:
        cmd.append("--strict")
    result = subprocess.run(cmd, cwd=staging_dir, env=_zensical_env(), check=False)
    if result.returncode != 0:
        return result.returncode
    staged_site = staging_dir / "site"
    target_site = site_dir.resolve()
    if target_site != staged_site.resolve():
        if target_site.exists():
            shutil.rmtree(target_site)
        shutil.copytree(staged_site, target_site)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build or serve Leitwerk docs with Zensical.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build", help="Stage docs and run zensical build")
    build_parser.add_argument("--strict", action="store_true", help="Fail on warnings/broken links")
    build_parser.add_argument("--site-dir", type=Path, default=None, help="Output site directory")
    build_parser.add_argument(
        "--stage-only", action="store_true", help="Stage files without invoking zensical"
    )

    serve_parser = subparsers.add_parser("serve", help="Stage docs and run zensical serve")
    serve_parser.add_argument(
        "-a", "--dev-addr", default="127.0.0.1:8006", help="Host:port to bind"
    )

    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent
    staging_dir = repo_root / ".zensical-staging"

    if args.command == "build":
        if args.stage_only:
            staged_config = stage_docs(repo_root, staging_dir, clean=True)
            print(f"Staged Zensical config at {staged_config}")
            return 0
        target_site = args.site_dir or (repo_root / "site")
        return build_site(repo_root, staging_dir, target_site, strict=args.strict)

    staged_config = stage_docs(repo_root, staging_dir, clean=True)
    zensical = find_zensical(repo_root)
    stop_event = threading.Event()
    watcher = threading.Thread(
        target=_watch_and_restage,
        args=(repo_root, staging_dir, stop_event),
        daemon=True,
    )
    watcher.start()
    try:
        cmd = [zensical, "serve", "-f", str(staged_config), "-a", args.dev_addr]
        return subprocess.run(cmd, cwd=staging_dir, env=_zensical_env(), check=False).returncode
    finally:
        stop_event.set()
        watcher.join(timeout=2.0)


if __name__ == "__main__":
    sys.exit(main())
