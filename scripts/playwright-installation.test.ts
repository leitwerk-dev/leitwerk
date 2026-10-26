import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { browserOutputDir, createBrowserOutputRoot } from "./test-browser.js";

describe("CI browser installation", () => {
	it("isolates browser artifacts across engines and simultaneous runs in one checkout", () => {
		const repo = mkdtempSync(path.join(tmpdir(), "leitwerk-browser-outputs-"));
		onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
		const roots = [createBrowserOutputRoot(repo), createBrowserOutputRoot(repo)];
		const outputs = roots.flatMap((root) =>
			["chromium-1", "chromium-2", "firefox-1", "firefox-2", "webkit-1", "webkit-2"].map((name) => {
				const output = browserOutputDir({
					LEITWERK_BROWSER_OUTPUT_ROOT: root,
					LEITWERK_BROWSER_ENGINE: name.split("-")[0],
					LEITWERK_BROWSER_OUTPUT_NAME: name,
				});
				if (!output) throw new Error("Missing browser output directory");
				mkdirSync(output);
				writeFileSync(path.join(output, "trace.zip"), name);
				return output;
			}),
		);
		expect(new Set(outputs).size).toBe(12);
		// Playwright cleans its output on startup. A second run must retain every trace.
		for (const output of outputs.slice(0, 6)) rmSync(output, { recursive: true });
		for (const output of outputs.slice(6)) {
			expect(readFileSync(path.join(output, "trace.zip"), "utf8")).toBe(path.basename(output));
		}
	});
});
