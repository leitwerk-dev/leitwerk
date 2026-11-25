"""Unit and integration tests for scripts/build_docs.py."""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_docs  # noqa: E402
import zensical_likec4  # noqa: E402


class BuildDocsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _write(self, rel: str, content: str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_rewrite_staged_links_extension(self) -> None:
        md = (
            "See [SDK](../../docs/extensions/process-sdk.md#api-compatibility), "
            "[Other](../other/README.md), "
            "[Wiki](../../packages/wiki/README.md#rules), "
            "and [Graph](process.mmd).\n"
            "[ref]: ../../docs/users/solution-wiki.md\n"
        )
        rewritten = build_docs.rewrite_staged_links(md, "extension")
        self.assertIn("[SDK](../../../extensions/process-sdk.md#api-compatibility)", rewritten)
        self.assertIn("[Other](../other/README.md)", rewritten)
        self.assertIn("[Wiki](../wiki/README.md#rules)", rewritten)
        self.assertIn("[Graph](process.mmd)", rewritten)
        self.assertIn("[ref]: ../../../users/solution-wiki.md", rewritten)

    def test_rewrite_staged_links_wiki(self) -> None:
        md = (
            "See [User guide](../../docs/users/solution-wiki.md) and "
            "[Jira](../../extensions/jira/README.md).\n"
        )
        rewritten = build_docs.rewrite_staged_links(md, "wiki")
        self.assertIn("[User guide](../../../users/solution-wiki.md)", rewritten)
        self.assertIn("[Jira](../jira/README.md)", rewritten)

    def test_rewrite_doc_links_at_multiple_depths(self) -> None:
        cases = [
            (
                Path("index.md"),
                "[Coding](../extensions/coding/README.md#rules) [Wiki](../packages/wiki/README.md)",
                "[Coding](extensions/bundled/coding/README.md#rules) [Wiki](extensions/bundled/wiki/README.md)",
            ),
            (
                Path("extensions/index.md"),
                "[Coding](../../extensions/coding/README.md) [Wiki](../../packages/wiki/README.md#schema)",
                "[Coding](bundled/coding/README.md) [Wiki](bundled/wiki/README.md#schema)",
            ),
            (
                Path("maintainers/architecture.md"),
                "[Coding](../../extensions/coding/README.md#branch) [Wiki](../../packages/wiki/README.md) [Local](testing.md)",
                "[Coding](../extensions/bundled/coding/README.md#branch) [Wiki](../extensions/bundled/wiki/README.md) [Local](testing.md)",
            ),
            (
                Path("a/b/deep.md"),
                "[Coding](../../../extensions/coding/README.md) [Ext](https://example.com)",
                "[Coding](../../extensions/bundled/coding/README.md) [Ext](https://example.com)",
            ),
        ]
        for rel_path, source, expected in cases:
            with self.subTest(rel_path=str(rel_path)):
                self.assertEqual(build_docs.rewrite_doc_links(source, rel_path, self.root), expected)

    def test_stage_docs_copies_rewrites_and_injects_nav(self) -> None:
        self._write("docs/index.md", "# Home\n[Alpha](../extensions/alpha/README.md)\n")
        self._write("docs/maintainers/arch.md", "# Arch\n[Wiki](../../packages/wiki/README.md)\n")
        self._write("docs/.DS_Store", "junk")
        self._write(
            "extensions/alpha/README.md",
            "# Alpha\n[SDK](../../docs/extensions/process-sdk.md)\n[Wiki](../../packages/wiki/README.md)\n",
        )
        self._write("extensions/alpha/process.mmd", "graph TD; A-->B;\n")
        self._write("extensions/beta/README.md", "# Beta\n")
        self._write("extensions/node_modules/ignored/README.md", "# Ignored\n")
        self._write(
            "packages/wiki/README.md",
            "# Wiki\n[Alpha](../../extensions/alpha/README.md)\n",
        )
        self._write(
            "zensical.toml",
            '[project]\n'
            'site_name = "Test"\n'
            'docs_dir = "docs"\n'
            'site_dir = "site"\n'
            'nav = [\n'
            '  { "Home" = "index.md" },\n'
            '  { "Extensions" = [\n'
            '    # __BUNDLED_EXTENSIONS_NAV__\n'
            '  ] },\n'
            ']\n'
            '[project.markdown_extensions.pymdownx.snippets]\n'
            'base_path = ["."]\n',
        )

        staging = self.root / ".zensical-staging"
        staged_config = build_docs.stage_docs(self.root, staging)
        self.assertTrue(staged_config.is_file())
        self.assertFalse((staging / "docs" / ".DS_Store").exists())
        self.assertTrue((staging / "docs" / "extensions" / "bundled" / "alpha" / "process.mmd").is_file())
        self.assertFalse((staging / "docs" / "extensions" / "bundled" / "node_modules").exists())

        index_staged = (staging / "docs" / "index.md").read_text(encoding="utf-8")
        self.assertIn("[Alpha](extensions/bundled/alpha/README.md)", index_staged)

        arch_staged = (staging / "docs" / "maintainers" / "arch.md").read_text(encoding="utf-8")
        self.assertIn("[Wiki](../extensions/bundled/wiki/README.md)", arch_staged)

        alpha_staged = (staging / "docs" / "extensions" / "bundled" / "alpha" / "README.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("../../../extensions/process-sdk.md", alpha_staged)
        self.assertIn("../wiki/README.md", alpha_staged)

        wiki_staged = (staging / "docs" / "extensions" / "bundled" / "wiki" / "README.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("../alpha/README.md", wiki_staged)

        cfg = staged_config.read_text(encoding="utf-8")
        self.assertIn('"Built-in extensions"', cfg)
        self.assertIn('"alpha" = "extensions/bundled/alpha/README.md"', cfg)
        self.assertIn('"beta" = "extensions/bundled/beta/README.md"', cfg)
        self.assertIn('"wiki (core package)" = "extensions/bundled/wiki/README.md"', cfg)
        self.assertNotIn(build_docs.NAV_MARKER, cfg)
        self.assertIn(f'base_path = ["{self.root.resolve().as_posix()}"]', cfg)

    def test_stage_docs_raises_when_nav_marker_missing(self) -> None:
        self._write("docs/index.md", "# Home\n")
        self._write("zensical.toml", '[project]\nsite_name = "Test"\ndocs_dir = "docs"\nsite_dir = "site"\n')
        with self.assertRaises(ValueError):
            build_docs.stage_docs(self.root, self.root / ".zensical-staging")

    def test_stage_docs_incremental_restage_syncs_edits_and_deletes(self) -> None:
        self._write("docs/index.md", "# Home v1\n")
        self._write("docs/temp.md", "# Temp\n")
        self._write(
            "zensical.toml",
            '[project]\nsite_name = "Test"\ndocs_dir = "docs"\nsite_dir = "site"\n'
            'nav = [{ "Home" = "index.md" }, { "Extensions" = [\n  # __BUNDLED_EXTENSIONS_NAV__\n] }]\n',
        )
        staging = self.root / ".zensical-staging"
        build_docs.stage_docs(self.root, staging, clean=True)
        self.assertTrue((staging / "docs" / "temp.md").is_file())

        self._write("docs/index.md", "# Home v2\n")
        (self.root / "docs" / "temp.md").unlink()
        build_docs.stage_docs(self.root, staging, clean=False)
        self.assertEqual((staging / "docs" / "index.md").read_text(encoding="utf-8"), "# Home v2\n")
        self.assertFalse((staging / "docs" / "temp.md").exists())

    def test_find_zensical_prefers_active_interpreter_bin(self) -> None:
        active_bin = self.root / "active-env" / "bin"
        active_bin.mkdir(parents=True)
        active_py = active_bin / "python"
        active_zensical = active_bin / "zensical"
        active_py.write_text("", encoding="utf-8")
        active_zensical.write_text("", encoding="utf-8")

        venv_zensical = self.root / ".venv" / "bin" / "zensical"
        venv_zensical.parent.mkdir(parents=True)
        venv_zensical.write_text("", encoding="utf-8")

        with mock.patch.object(sys, "executable", str(active_py)):
            self.assertEqual(build_docs.find_zensical(self.root), str(active_zensical))

    def test_git_tracked_filter_excludes_untracked_extension(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        self._write("extensions/tracked/README.md", "# Tracked\n")
        self._write("extensions/untracked/README.md", "# Untracked\n")
        subprocess.run(["git", "add", "extensions/tracked/README.md"], cwd=self.root, check=True)

        extensions, wiki = build_docs.discover_bundled_docs(self.root)
        self.assertEqual([name for name, _ in extensions], ["tracked"])
        self.assertIsNone(wiki)

    def test_discover_bundled_docs_falls_back_when_git_missing(self) -> None:
        (self.root / ".git").mkdir()
        self._write("extensions/alpha/README.md", "# Alpha\n")
        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError):
            extensions, wiki = build_docs.discover_bundled_docs(self.root)
        self.assertEqual([name for name, _ in extensions], ["alpha"])
        self.assertIsNone(wiki)

    def test_zensical_strict_build_validates_staged_links(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent
        zensical = build_docs.find_zensical(repo_root)
        self._write("docs/index.md", "# Home\n[Alpha](../extensions/alpha/README.md#contract)\n")
        self._write("docs/extensions/process-sdk.md", "# Process SDK\n## API compatibility\n")
        self._write("docs/maintainers/arch.md", "# Arch\n[Wiki](../../packages/wiki/README.md)\n")
        self._write(
            "extensions/alpha/README.md",
            "# Alpha\n## Contract\n"
            "[SDK](../../docs/extensions/process-sdk.md#api-compatibility)\n"
            "[Wiki](../../packages/wiki/README.md)\n"
            "[Graph](process.mmd)\n",
        )
        self._write("extensions/alpha/process.mmd", "graph TD; A-->B;\n")
        self._write("packages/wiki/README.md", "# Wiki\n[Alpha](../../extensions/alpha/README.md)\n")
        self._write(
            "zensical.toml",
            '[project]\n'
            'site_name = "Test"\n'
            'docs_dir = "docs"\n'
            'site_dir = "site"\n'
            'nav = [\n'
            '  { "Home" = "index.md" },\n'
            '  { "Extensions" = [\n'
            '    { "Process SDK" = "extensions/process-sdk.md" },\n'
            '    # __BUNDLED_EXTENSIONS_NAV__\n'
            '  ] },\n'
            '  { "Maintainers" = [\n'
            '    { "Arch" = "maintainers/arch.md" },\n'
            '  ] },\n'
            ']\n'
            '[project.validation]\n'
            'invalid_links = true\n'
            'invalid_link_anchors = true\n',
        )

        staging = self.root / ".zensical-staging"
        staged_cfg = build_docs.stage_docs(self.root, staging)
        ok_res = subprocess.run(
            [zensical, "build", "--clean", "--strict", "-f", str(staged_cfg)],
            cwd=staging,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(ok_res.returncode, 0, ok_res.stdout + ok_res.stderr)
        self.assertTrue((staging / "site" / "extensions" / "bundled" / "alpha" / "index.html").is_file())
        self.assertTrue((staging / "site" / "extensions" / "bundled" / "wiki" / "index.html").is_file())

        with (self.root / "extensions/alpha/README.md").open("a", encoding="utf-8") as fh:
            fh.write("\n[Broken](../missing/README.md)\n")
        staged_cfg = build_docs.stage_docs(self.root, staging)
        fail_res = subprocess.run(
            [zensical, "build", "--clean", "--strict", "-f", str(staged_cfg)],
            cwd=staging,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(fail_res.returncode, 0)
        plain_output = _ANSI_RE.sub("", fail_res.stdout + fail_res.stderr)
        self.assertIn("missing/README.md", plain_output)


class LikeC4Test(unittest.TestCase):
    CONFIG = (
        '[project]\nsite_name = "Test"\ndocs_dir = "docs"\nsite_dir = "site"\n'
        'nav = [{ "Home" = "index.md" }, { "Extensions" = [\n  # __BUNDLED_EXTENSIONS_NAV__\n] }]\n'
    )
    MODEL = (
        "views {\n"
        "  view index {\n    include *\n  }\n"
        "  view containers of leitwerk.server {\n    include *\n  }\n"
        "  deployment view dockerDeployment {\n    include docker.**\n  }\n"
        "  // view commentedOut {\n"
        "  /* view blockCommented { } */\n"
        "}\n"
    )

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        bundle = mock.patch.object(
            zensical_likec4, "generate_bundle", return_value=b"/* likec4 bundle */"
        )
        self.generate_bundle = bundle.start()
        self.addCleanup(bundle.stop)

    def _write(self, rel: str, content: str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def _page(self, body: str) -> None:
        self._write("zensical.toml", self.CONFIG)
        self._write("docs/maintainers/likec4/views.c4", self.MODEL)
        self._write("docs/index.md", f"# Home\n\n{body}")

    def test_fence_format_renders_view_element(self) -> None:
        html = zensical_likec4.fence_format("  containers\n", "likec4-view", "likec4-view", {}, None)
        self.assertEqual(
            html,
            '<likec4-view class="likec4-view" view-id="containers" browser="true"></likec4-view>',
        )

    def test_fence_format_rejects_invalid_ids(self) -> None:
        for source in ["", "two words", '<script>"', "index\ncontainers"]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                zensical_likec4.fence_format(source, "likec4-view", "likec4-view", {}, None)

    def test_discover_view_ids_ignores_comments(self) -> None:
        self._write("model/views.c4", self.MODEL)
        self.assertEqual(
            zensical_likec4.discover_view_ids(self.root / "model"),
            {"index", "containers", "dockerDeployment"},
        )

    def test_referenced_view_ids_reads_likec4_fences_only(self) -> None:
        md = (
            "```likec4-view\nindex\n```\n\n"
            "```mermaid\ngraph TD; A-->B;\n```\n\n"
            "!!! note\n    ````likec4-view\n    containers\n    ````\n"
        )
        self.assertEqual(zensical_likec4.referenced_view_ids(md), ["index", "containers"])

    def test_stage_docs_includes_bundle_for_known_view(self) -> None:
        self._page("```likec4-view\ncontainers\n```\n")
        staging = self.root / ".zensical-staging"
        build_docs.stage_docs(self.root, staging)
        self.assertEqual(
            (staging / "docs" / "assets" / "javascripts" / "likec4-views.js").read_bytes(),
            b"/* likec4 bundle */",
        )

        # Incremental restage keeps the generated bundle.
        build_docs.stage_docs(self.root, staging, clean=False)
        self.assertTrue((staging / "docs" / "assets" / "javascripts" / "likec4-views.js").is_file())

    def test_stage_docs_rejects_unknown_view(self) -> None:
        self._page("```likec4-view\nmissingView\n```\n")
        with self.assertRaisesRegex(ValueError, "'missingView' in index.md"):
            build_docs.stage_docs(self.root, self.root / ".zensical-staging")

    def test_zensical_build_renders_fence_as_view_element(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent
        zensical = build_docs.find_zensical(repo_root)
        self._page("```likec4-view\nindex\n```\n\n```mermaid\ngraph TD; A-->B;\n```\n")
        self._write(
            "zensical.toml",
            self.CONFIG
            + "[project.markdown_extensions.pymdownx.superfences]\n"
            "custom_fences = [\n"
            '  { name = "mermaid", class = "mermaid", format = "pymdownx.superfences.fence_code_format" },\n'
            '  { name = "likec4-view", class = "likec4-view", format = "zensical_likec4.fence_format" },\n'
            "]\n",
        )
        staging = self.root / ".zensical-staging"
        staged_cfg = build_docs.stage_docs(self.root, staging)
        res = subprocess.run(
            [zensical, "build", "--clean", "--strict", "-f", str(staged_cfg)],
            cwd=staging,
            env=build_docs._zensical_env(),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        html = (staging / "site" / "index.html").read_text(encoding="utf-8")
        self.assertIn('<likec4-view class="likec4-view" view-id="index" browser="true">', html)
        self.assertIn('class="mermaid"', html)


if __name__ == "__main__":
    unittest.main()
