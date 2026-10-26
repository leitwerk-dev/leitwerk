"""Integration checks for the repository documentation layout."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RepositoryDocsTest(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        sources = {
            "docs/index.md": "# Home\n[Extension](../extensions/example/README.md#contract)\n",
            "docs/guide.md": "# Guide\n",
            "docs/assets/example.txt": "Core asset\n",
            "extensions/example/README.md": (
                "# Example\n## Contract\n[Guide](../../docs/guide.md)\n"
                "[Other](../other/README.md)\n[Graph](process.mmd)\n"
                "[Wiki](../../packages/wiki/README.md)\n"
            ),
            "extensions/example/process.mmd": "graph TD; A-->B;\n",
            "extensions/other/README.md": "# Other\n",
            "extensions/example/node_modules/ignored/README.md": "# Not published\n",
            "packages/wiki/README.md": "# Wiki\n",
        }
        for name, content in sources.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        hook = Path(__file__).with_name("docs_hooks.py").resolve()
        (self.root / "mkdocs.yml").write_text(
            "site_name: Test\ndocs_dir: docs\nsite_dir: site\nstrict: true\n"
            "validation:\n  links:\n    not_found: warn\n    anchors: warn\n"
            f"hooks:\n  - {hook.as_posix()}\n"
            "nav:\n  - Home: index.md\n  - Build:\n      - Guide: guide.md\n"
        )

    def build(self):
        return subprocess.run(
            [sys.executable, "-m", "mkdocs", "build", "--strict"],
            cwd=self.root, text=True, capture_output=True,
        )

    def test_relative_links_and_existing_urls(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        site = self.root / "site"
        self.assertIn('href="extensions/example/#contract"', (site / "index.html").read_text())
        extension = (site / "extensions/example/index.html").read_text()
        for target in ["../../guide/", "../other/", "process.mmd", "../../packages/wiki/"]:
            self.assertIn(f'href="{target}"', extension)
        self.assertTrue((site / "guide/index.html").is_file())
        self.assertTrue((site / "assets/example.txt").is_file())
        self.assertTrue((site / "extensions/example/process.mmd").is_file())
        self.assertFalse((site / "docs").exists())
        self.assertFalse((site / "extensions/example/node_modules").exists())

    def test_missing_extension_link_still_fails_strict_build(self):
        with (self.root / "extensions/example/README.md").open("a") as source:
            source.write("\n[Missing](../missing/README.md)\n")
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing/README.md", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
