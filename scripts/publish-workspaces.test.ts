import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSupportedNodeRange } from "./publish-workspaces.mjs";

describe("published workspace Node engines", () => {
	it.each([
		">=26 <27",
		">=28 <29",
	])("accepts the root's %s range without a hardcoded major", (range) => {
		expect(isSupportedNodeRange(range, range)).toBe(true);
	});

	it.each([
		undefined,
		"",
		">=22",
		">=24",
		">=26",
		">=26 <28",
	])("rejects workspace range %s when the root requires Node 26 only", (range) => {
		expect(isSupportedNodeRange(range, ">=26 <27")).toBe(false);
	});

	it.each([undefined, ""])("rejects a missing root engine contract (%s)", (range) => {
		expect(isSupportedNodeRange(range, range)).toBe(false);
	});

	it("checks the built repository's publishable workspaces through the CLI", () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const result = spawnSync(process.execPath, ["scripts/publish-workspaces.mjs", "check"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("[publish:check] OK");
	});
});
