import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { parse } from "yaml";
import { browserOutputDir, createBrowserOutputRoot } from "./test-browser.js";

describe("CI browser installation", () => {
	it("isolates browser artifacts across engines and simultaneous runs in one checkout", () => {
		const repo = mkdtempSync(path.join(tmpdir(), "leitwerk-browser-outputs-"));
		onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
		const roots = [createBrowserOutputRoot(repo), createBrowserOutputRoot(repo)];
		const outputs = roots.flatMap((root) =>
			["chromium", "firefox", "webkit", "firefox-layout"].map((name) => {
				const output = browserOutputDir({
					LEITWERK_BROWSER_OUTPUT_ROOT: root,
					LEITWERK_BROWSER_ENGINE: name === "firefox-layout" ? "firefox" : name,
					...(name === "firefox-layout" ? { LEITWERK_BROWSER_OUTPUT_NAME: name } : {}),
				});
				if (!output) throw new Error("Missing browser output directory");
				mkdirSync(output);
				writeFileSync(path.join(output, "trace.zip"), name);
				return output;
			}),
		);
		expect(new Set(outputs).size).toBe(8);
		// Playwright cleans its output on startup. A second run must retain every trace.
		for (const output of outputs.slice(0, 4)) rmSync(output, { recursive: true });
		for (const output of outputs.slice(4)) {
			expect(readFileSync(path.join(output, "trace.zip"), "utf8")).toBe(path.basename(output));
		}
	});

	it.each([
		["ci.yml", "validate"],
		["publish.yml", "validate"],
		["publish-rc.yml", "validate"],
	])("uses Node 26 for browser installation and validation in %s", (filename, jobName) => {
		const workflowPath = fileURLToPath(
			new URL(`../.github/workflows/${filename}`, import.meta.url),
		);
		const workflow = parse(readFileSync(workflowPath, "utf8"));
		const steps = workflow.jobs[jobName].steps;
		const installer = steps.findIndex(
			(step: { run?: string }) =>
				step.run === "npx playwright install --with-deps chromium firefox webkit",
		);
		expect(installer).toBeGreaterThan(0);
		const nodeSetups = steps.filter((step: { uses?: string }) =>
			step.uses?.startsWith("actions/setup-node@"),
		);
		expect(nodeSetups.length).toBeGreaterThan(0);
		for (const setup of nodeSetups) expect(setup.with["node-version"]).toBe(26);
		expect(steps[installer]["timeout-minutes"]).toBe(5);
		expect(steps.findIndex((step: { run?: string }) => step.run === "npm ci")).toBeLessThan(
			installer,
		);
		expect(
			steps.findIndex((step: { run?: string }) => step.run === "npm run test:full"),
		).toBeGreaterThan(installer);
	});
});
