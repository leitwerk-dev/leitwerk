"""Checks for documentation staging and the strict Zensical build."""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest import mock

import build_docs
import zensical_likec4

CONFIG = '''[project]
site_name = "Test docs"
nav = ["index.md", "extensions/process-sdk.md",
    # __BUNDLED_EXTENSIONS_NAV__
]
validation = { invalid_links = true, invalid_link_anchors = true }
[project.markdown_extensions.pymdownx.superfences]
custom_fences = [
    { name = "mermaid", class = "mermaid", format = "pymdownx.superfences.fence_code_format" },
    { name = "likec4-view", class = "likec4-view", format = "zensical_likec4.fence_format" },
]
'''


class BuildDocsTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.stage = self.root / ".zensical-staging"
        self.write("zensical.toml", CONFIG)
        self.write("docs/index.md", "# Home\n")
        self.write("docs/extensions/process-sdk.md", "# SDK\n## API compatibility\n")

    def write(self, rel: str, content: str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def build_with_views(self):
        (self.root / build_docs.LIKEC4_WORKSPACE).mkdir(parents=True, exist_ok=True)

        def generate(_repo, _workspace, stage, bundle):
            (stage / zensical_likec4.MODEL_NAME).write_text('{"views": {"index": {}}}', encoding="utf-8")
            bundle.parent.mkdir(parents=True)
            bundle.write_bytes(b"/* bundle */")

        with mock.patch.object(zensical_likec4, "generate", side_effect=generate):
            config = build_docs.stage_docs(self.root, self.stage)
        return build_docs.run_zensical(config, "build", "--strict", capture_output=True)

    def test_strict_build_publishes_bundled_pages_and_diagrams(self) -> None:
        self.write("docs/index.md", "# Home\n[Alpha](../extensions/alpha/README.md#contract)\n\n"
                   "```mermaid\ngraph TD; A-->B;\n```\n\n```likec4-view\nindex\n```\n")
        self.write("docs/extensions/process-sdk.md", "# SDK\n## API compatibility\n"
                   "[Wiki](../../packages/wiki/README.md)\n")
        alpha = self.write("extensions/alpha/README.md", "# Alpha\n## Contract\n"
                           "[SDK][sdk] [Wiki](../../packages/wiki/README.md) [Graph](process.mmd)\n\n"
                           "[sdk]: <../../docs/extensions/process-sdk.md#api-compatibility>\n")
        self.write("extensions/alpha/process.mmd", "graph TD; A-->B;\n")
        self.write("packages/wiki/README.md", "# Wiki\n[Alpha](../../extensions/alpha/README.md)\n")
        self.write("docs/.DS_Store", "junk")
        self.write("extensions/node_modules/README.md", "# Ignored\n")
        result = self.build_with_views()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        site = self.stage / "site"
        home = (site / "index.html").read_text(encoding="utf-8")
        self.assertIn("Built-in extensions", home)
        self.assertIn('href="extensions/bundled/alpha/#contract"', home)
        self.assertIn('<likec4-view ', home)
        self.assertIn('class="mermaid"', home)
        bundled = site / "extensions/bundled"
        alpha_html = (bundled / "alpha/index.html").read_text(encoding="utf-8")
        self.assertIn('href="../../process-sdk/#api-compatibility"', alpha_html)
        self.assertIn('href="../wiki/"', alpha_html)
        self.assertTrue((bundled / "wiki/index.html").is_file())
        self.assertTrue((bundled / "alpha/process.mmd").is_file())
        self.assertEqual((site / build_docs.LIKEC4_BUNDLE).read_bytes(), b"/* bundle */")
        self.assertFalse((self.stage / "docs/.DS_Store").exists())
        self.assertFalse((bundled / "node_modules").exists())

        with alpha.open("a", encoding="utf-8") as fh:
            fh.write("\n[Broken](../missing/README.md)\n")
        result = self.build_with_views()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing/README.md", re.sub(r"\x1b\[[0-9;]*m", "", result.stdout + result.stderr))

    def test_stage_docs_requires_nav_marker(self) -> None:
        self.write("zensical.toml", CONFIG.replace(build_docs.NAV_MARKER, ""))
        with self.assertRaisesRegex(ValueError, "Missing .*NAV"):
            build_docs.stage_docs(self.root, self.stage)

    def test_git_tracked_filter_excludes_untracked_extension(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        self.write("extensions/tracked/README.md", "# Tracked\n")
        self.write("extensions/untracked/README.md", "# Untracked\n")
        subprocess.run(["git", "add", "extensions/tracked/README.md"], cwd=self.root, check=True)
        build_docs.stage_docs(self.root, self.stage)
        bundled = self.stage / "docs/extensions/bundled"
        self.assertTrue((bundled / "tracked/README.md").is_file())
        self.assertFalse((bundled / "untracked").exists())

    def test_staging_falls_back_when_git_is_missing(self) -> None:
        (self.root / ".git").mkdir()
        self.write("extensions/alpha/README.md", "# Alpha\n")
        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError):
            build_docs.stage_docs(self.root, self.stage)
        self.assertTrue((self.stage / "docs/extensions/bundled/alpha/README.md").is_file())

    def test_strict_build_rejects_unknown_view(self) -> None:
        self.write("docs/index.md", "# Home\n\n```likec4-view\nmissingView\n```\n")
        result = self.build_with_views()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Unknown LikeC4 view 'missingView'", result.stdout + result.stderr)
