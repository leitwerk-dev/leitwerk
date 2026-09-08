import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("CI browser installation", () => {
	it.each([
		["ci.yml", "validate"],
		["publish.yml", "validate"],
	])("isolates the Node 24 installer and restores Node 26 in %s", (filename, jobName) => {
		const workflowPath = fileURLToPath(
			new URL(`../.github/workflows/${filename}`, import.meta.url),
		);
		const workflow = parse(readFileSync(workflowPath, "utf8"));
		const steps = workflow.jobs[jobName].steps;
		const installer = steps.findIndex(
			(step: { run?: string }) => step.run === "npx playwright install --with-deps chromium",
		);
		expect(installer).toBeGreaterThan(0);
		expect(steps[installer - 1].uses).toMatch(/^actions\/setup-node@/u);
		expect(steps[installer - 1].with["node-version"]).toBe(24);
		expect(steps[installer]["timeout-minutes"]).toBe(5);
		expect(steps[installer + 1].uses).toMatch(/^actions\/setup-node@/u);
		expect(steps[installer + 1].with["node-version"]).toBe(26);
		expect(steps.findIndex((step: { run?: string }) => step.run === "npm ci")).toBeLessThan(
			installer,
		);
		expect(
			steps.findIndex((step: { run?: string }) => step.run === "npm run test:full"),
		).toBeGreaterThan(installer + 1);
	});
});
