import { describe, expect, it } from "vitest";
import { assertConfinedSymlinks } from "./symlink-confinement.js";

describe("workspace symlink confinement", () => {
	it("resolves symlink components before parent traversal", () => {
		expect(() =>
			assertConfinedSymlinks(
				new Map([
					["a", "."],
					["sub/b", "../a/../outside"],
				]),
			),
		).toThrow("escapes the workspace");
	});

	it("accepts confined chains, parent traversal, and dangling targets", () => {
		expect(() =>
			assertConfinedSymlinks(
				new Map([
					["alias", "sub/directory"],
					["sub/link", "../alias/../missing"],
					["parent-link", "alias/../../missing"],
					["dangling", "missing/target"],
				]),
			),
		).not.toThrow();
	});

	it("rejects cycles even when targets occur later in the archive", () => {
		expect(() =>
			assertConfinedSymlinks(
				new Map([
					["a", "b"],
					["b", "a"],
				]),
			),
		).toThrow("Symlink cycle");
	});
});
