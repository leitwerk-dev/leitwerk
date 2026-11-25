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

import zensical_likec4

NAV_MARKER = "# __BUNDLED_EXTENSIONS_NAV__"
IGNORED_NAMES = {".DS_Store", "__pycache__"}
LIKEC4_WORKSPACE = Path("docs") / "maintainers" / "likec4"
LIKEC4_BUNDLE = Path("assets") / "javascripts" / "likec4-views.js"
BUNDLED = Path("extensions/bundled")
WIKI_README = Path("packages/wiki/README.md")

_LINK_RE = re.compile(r"(\]\(|^\[[^\]]+\]:\s*)(<)?([^)\s>]+)(>)?", re.MULTILINE)


def _bundled_candidates(repo_root: Path) -> list[Path]:
    patterns = ["extensions/*/README.md", "extensions/*/*.mmd", WIKI_README.as_posix()]
    if (repo_root / ".git").exists():
        try:
            result = subprocess.run(
                ["git", "ls-files", "-z", "--", *patterns],
                cwd=repo_root, text=True, capture_output=True, check=False,
            )
            if result.returncode == 0:
                return [Path(name) for name in result.stdout.split("\0") if name]
        except FileNotFoundError:
            pass
    return [path.relative_to(repo_root) for pattern in patterns for path in repo_root.glob(pattern)]


def _source_paths(repo_root: Path) -> dict[Path, Path]:
    """Map the files we publish to their paths relative to staged docs/."""
    docs_root = repo_root / "docs"
    paths = {
        src: src.relative_to(docs_root)
        for src in docs_root.rglob("*")
        if src.is_file() and IGNORED_NAMES.isdisjoint(src.relative_to(docs_root).parts)
    }
    bundled = {
        rel for rel in _bundled_candidates(repo_root)
        if (repo_root / rel).is_file()
    }
    for rel in sorted(bundled):
        if rel == WIKI_README:
            paths[repo_root / rel] = BUNDLED / "wiki/README.md"
        elif (
            len(rel.parts) == 3
            and rel.parts[1] != "node_modules"
            and rel.with_name("README.md") in bundled
        ):
            paths[repo_root / rel] = BUNDLED / rel.parent.name / rel.name
    return paths


def _rewrite_links(markdown: str, source: Path, paths: dict[Path, Path]) -> str:
    def replace(match: re.Match[str]) -> str:
        prefix, open_angle, target, close_angle = match.groups()
        if target.startswith(("/", "#")) or re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", target):
            return match.group(0)
        path, suffix = re.fullmatch(r"([^?#]*)(.*)", target).groups()
        staged = paths.get((source.parent / path).resolve())
        if staged is None:
            return match.group(0)
        link = Path(os.path.relpath(staged, paths[source].parent)).as_posix()
        if link == path.removeprefix("./"):
            return match.group(0)
        return f"{prefix}{open_angle or ''}{link}{suffix}{close_angle or ''}"

    return _LINK_RE.sub(replace, markdown)


def _toml_str(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _format_bundled_nav(paths: dict[Path, Path]) -> str:
    entries = []
    for src, dest in paths.items():
        if dest.is_relative_to(BUNDLED) and dest.name == "README.md":
            name = "wiki (core package)" if src.parent.parent.name == "packages" else dest.parent.name
            entries.append(f"      {{ {_toml_str(name)} = {_toml_str(dest.as_posix())} }},")
    return '{ "Built-in extensions" = [\n' + "\n".join(entries) + "\n    ] }," if entries else ""


def _staged_config(repo_root: Path, paths: dict[Path, Path]) -> str:
    config_text = (repo_root / "zensical.toml").read_text(encoding="utf-8")
    if NAV_MARKER not in config_text:
        raise ValueError(f"Missing {NAV_MARKER} in zensical.toml")

    return config_text.replace(NAV_MARKER, _format_bundled_nav(paths), 1)


def stage_docs(repo_root: Path, staging_dir: Path) -> Path:
    """Stage docs/, bundled extension READMEs, and generated zensical.toml."""
    repo_root = repo_root.resolve()
    staging_dir = staging_dir.resolve()
    staged_docs = staging_dir / "docs"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staged_docs.mkdir(parents=True)

    paths = _source_paths(repo_root)
    config_text = _staged_config(repo_root, paths)
    for src, rel in paths.items():
        dst = staged_docs / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix == ".md":
            dst.write_text(_rewrite_links(src.read_text(encoding="utf-8"), src, paths), encoding="utf-8")
        else:
            shutil.copyfile(src, dst)

    workspace = repo_root / LIKEC4_WORKSPACE
    if workspace.is_dir():
        zensical_likec4.generate(repo_root, workspace, staging_dir, staged_docs / LIKEC4_BUNDLE)

    config = staging_dir / "zensical.toml"
    config.write_text(config_text, encoding="utf-8")
    return config


def run_zensical(
    config: Path, command: str, *flags: str, capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    scripts = str(Path(__file__).resolve().parent)
    pythonpath = os.pathsep.join(filter(None, (scripts, os.environ.get("PYTHONPATH"))))
    return subprocess.run(
        [sys.executable, "-m", "zensical", command, "-f", str(config), *flags],
        cwd=config.parent, env={**os.environ, "PYTHONPATH": pythonpath},
        text=True, capture_output=capture_output, check=False,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build or serve Leitwerk docs with Zensical.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build", help="Stage docs and run zensical build")
    build_parser.add_argument("--strict", action="store_true", help="Fail on warnings/broken links")

    serve_parser = subparsers.add_parser("serve", help="Stage docs and run zensical serve")
    serve_parser.add_argument(
        "-a", "--dev-addr", default="127.0.0.1:8006", help="Host:port to bind"
    )

    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent
    config = stage_docs(repo_root, repo_root / ".zensical-staging")
    if args.command == "build":
        flags = ("--clean", "--strict") if args.strict else ("--clean",)
    else:
        flags = ("-a", args.dev_addr)
    return run_zensical(config, args.command, *flags).returncode


if __name__ == "__main__":
    sys.exit(main())
