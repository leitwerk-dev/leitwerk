import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkspacePackageDirs } from "./workspace-packages.js";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace discovery", () => {
	it.each(["array", "object"])("expands %s declarations once per package", (shape) => {
		const parent = mkdtempSync(path.join(tmpdir(), "leitwerk-workspaces-"));
		tempDirs.push(parent);
		const root = path.join(parent, "root");
		for (const dir of ["root/packages/b", "root/packages/a", "root/direct", "sibling"]) {
			mkdirSync(path.join(parent, dir), { recursive: true });
			writeFileSync(path.join(parent, dir, "package.json"), "{}");
		}
		mkdirSync(path.join(root, "packages/no-manifest"));
		writeFileSync(path.join(root, "packages/not-a-directory"), "");
		const patterns = ["packages/*", "direct", "../sibling", "packages/a", "missing/*", null];
		writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({
				workspaces: shape === "array" ? patterns : { packages: patterns },
			}),
		);
		expect(listWorkspacePackageDirs(root)).toEqual(
			["root/direct", "root/packages/a", "root/packages/b", "sibling"].map((dir) =>
				path.join(parent, dir),
			),
		);
	});

	it.each([
		undefined,
		null,
		"packages/*",
		{},
		{ packages: "packages/*" },
	])("ignores unsupported workspace declarations: %j", (workspaces) => {
		expect(listWorkspacePackageDirs("/unused", { workspaces })).toEqual([]);
	});
});
