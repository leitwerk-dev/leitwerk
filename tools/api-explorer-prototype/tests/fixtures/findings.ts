import type { Snapshot } from "../../src/model";

/** @internal Complete loaded-source fixture; no ambient reports or repository imports. */
export function findingsFixture(): Snapshot {
	const source = { path: "pkg/helper.ts", line: 1, column: 1, snippet: "helper()" };
	return {
		version: 1,
		generatedAt: "2026-01-01",
		repository: { id: "fixture", name: "Fixture", revision: "rev", dirty: false },
		coverage: {
			complete: true,
			sourceFiles: 2,
			entryPoints: 1,
			extractedEntryPoints: 1,
			typescriptVersion: "6",
			limitations: [],
		},
		nodes: [
			{
				id: "entry",
				label: ".",
				kind: "entry",
				package: "pkg",
				source: { ...source, path: "pkg/index.ts" },
			},
			{
				id: "helper",
				label: "helper",
				kind: "function",
				package: "pkg",
				entry: ".",
				parentId: "entry",
				source,
				release: "internal",
			},
			{ id: "file", label: "helper.ts", kind: "file", package: "pkg", source },
		],
		occurrences: [
			{ ...source, id: "call", fileId: "file", targets: ["helper"], kind: "call", isTest: false },
		],
		relationships: [],
		diagnostics: [],
	};
}
