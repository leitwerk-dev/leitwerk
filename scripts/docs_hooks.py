"""Publish repository documentation without changing its relative links."""

from pathlib import Path

from mkdocs.plugins import event_priority
from mkdocs.structure.files import File, Files


def _repository_nav(items):
    return [
        {title: _repository_nav(target) if isinstance(target, list) else f"docs/{target}"
         for title, target in item.items()}
        for item in items
    ]


def on_config(config):
    config.nav = _repository_nav(config.nav)
    root = Path(config.docs_dir).parent
    config.nav.append({"Extensions": [
        {path.parent.name: path.relative_to(root).as_posix()}
        for path in sorted(root.glob("extensions/*/README.md"))
    ]})
    config.nav.append({"Package references": [{"Solution wikis": "packages/wiki/README.md"}]})


@event_priority(100)
def on_files(files, config):
    root = Path(config.docs_dir).parent
    # Resolve links in repository coordinates, but retain existing core page URLs.
    for file in files:
        # Pin both paths before changing the lookup key. Theme and generated
        # assets need not physically live beneath docs_dir.
        file.abs_src_path = file.abs_src_path
        file.dest_uri = file.dest_uri
        file.src_uri = f"docs/{file.src_uri}"
    published = Files(files)
    sources = [*sorted(root.glob("extensions/*/README.md")),
               *sorted(root.glob("extensions/*/*.mmd")),
               root / "packages/wiki/README.md"]
    for source in sources:
        published.append(File(
            source.relative_to(root).as_posix(), str(root), config.site_dir,
            config.use_directory_urls,
        ))
    return published
