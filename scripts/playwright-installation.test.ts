import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("CI browser installation", () => {
	it("keeps artifacts separate for every browser invocation in the full gate", () => {
		const packageJson = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		const script: string = packageJson.scripts["test:browser"];
		const invocations = script.match(/playwright test\b/g) ?? [];
		const outputs = [...script.matchAll(/--output=([^\s"]+)/g)].map((match) => match[1]);
		expect(invocations).toHaveLength(4);
		expect(outputs).toHaveLength(invocations.length);
		expect(new Set(outputs).size).toBe(outputs.length);
		// A parent output directory would also delete another invocation's artifacts.
		for (const output of outputs) {
			for (const other of outputs) expect(other.startsWith(`${output}/`)).toBe(false);
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
