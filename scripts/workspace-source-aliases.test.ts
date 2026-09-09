import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSourceAliases } from "./workspace-source-aliases.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findReplacement(specifier: string): string | undefined {
	return buildWorkspaceSourceAliases(repoRoot).find((alias) => alias.find.test(specifier))
		?.replacement;
}

describe("buildWorkspaceSourceAliases", () => {
	it("maps root workspace packages to source entrypoints", () => {
		expect(findReplacement("@leitwerk-dev/domain")).toBe(
			path.resolve(repoRoot, "packages/domain/src/index.ts"),
		);
		expect(findReplacement("@leitwerk-dev/server")).toBe(
			path.resolve(repoRoot, "packages/server/src/index.ts"),
		);
		expect(findReplacement("@leitwerk-dev/coding")).toBe(
			path.resolve(repoRoot, "extensions/coding/src/index.ts"),
		);
	});

	it("maps exported subpaths to source files without using dist outputs", () => {
		const aliases = buildWorkspaceSourceAliases(repoRoot);

		expect(findReplacement("@leitwerk-dev/test-support/integration")).toBe(
			path.resolve(repoRoot, "packages/test-support/src/integration.ts"),
		);
		expect(findReplacement("@leitwerk-dev/test-support/fakes")).toBe(
			path.resolve(repoRoot, "packages/test-support/src/fakes/index.ts"),
		);
		expect(
			aliases.every((alias) => !alias.replacement.includes(`${path.sep}dist${path.sep}`)),
		).toBe(true);
	});
});
