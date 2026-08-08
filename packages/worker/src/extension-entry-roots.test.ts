import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	entriesExistWithinAllowedRoots,
	parseExtensionAllowedRoots,
} from "./extension-entry-roots.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "leitwerk-extension-roots-"));
	tempDirs.push(root);
	const packageDir = path.join(root, "extensions", "example");
	const entryPath = path.join(packageDir, "src", "index.ts");
	mkdirSync(path.dirname(entryPath), { recursive: true });
	writeFileSync(entryPath, "export default {};\n");
	return {
		root,
		packageDir,
		entryPath,
		entry: {
			packageName: "@example/extension",
			packageDir,
			entryPath,
		},
	};
}

describe("development extension roots", () => {
	it("accepts an extension inside an explicit composition root", () => {
		const value = fixture();
		expect(
			entriesExistWithinAllowedRoots({
				entries: [value.entry],
				allowedRoots: [value.root],
			}),
		).toBe(true);
	});

	it("rejects an extension outside the allowed roots", () => {
		const value = fixture();
		const otherRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-other-root-"));
		tempDirs.push(otherRoot);
		expect(
			entriesExistWithinAllowedRoots({
				entries: [value.entry],
				allowedRoots: [otherRoot],
			}),
		).toBe(false);
	});

	it("parses only existing absolute development roots", () => {
		const value = fixture();
		expect(
			parseExtensionAllowedRoots(
				JSON.stringify([value.root, "relative", path.join(value.root, "missing")]),
			),
		).toEqual([realpathSync(value.root)]);
		expect(parseExtensionAllowedRoots("invalid")).toEqual([]);
	});
});
