import { describe, expect, it } from "vitest";
import { type Candidate, removalCandidates } from "../src/candidates";
import { findingsFixture } from "./fixtures/findings";
import { filterFindings, findingsExportParts } from "../src/findings-export";
import type { Occurrence, Snapshot } from "../src/model";

const occurrence: Occurrence = {
	id: "shared",
	fileId: "file",
	targets: ["helper"],
	kind: "call",
	isTest: true,
	path: "test.ts",
	line: 1,
	column: 1,
	snippet: 'helper("é")\n// evidence',
};
const candidate: Candidate = {
	...removalCandidates(findingsFixture())[0],
	id: "helper",
	node: { id: "helper", label: "Helper", kind: "function", package: "pkg" },
	action: "Make file-local",
	reason: "reason",
	routes: [],
	usages: [occurrence],
	cleanup: [occurrence],
	reports: ["main"],
	scopes: ["tests"],
	compatibility: "Internal API",
};
const snapshot: Snapshot = {
	version: 1,
	generatedAt: "2026-01-01",
	repository: { id: "main", name: "Main", revision: "rev", dirty: true },
	coverage: {
		complete: false,
		sourceFiles: 1,
		entryPoints: 1,
		extractedEntryPoints: 1,
		typescriptVersion: "6",
		limitations: ["Static only"],
	},
	nodes: [],
	occurrences: [],
	relationships: [],
	diagnostics: [{ severity: "warning", scope: "main", message: "Incomplete" }],
	reportLoadingIncomplete: true,
};

describe("finding filters", () => {
	const findings = [
		candidate,
		{
			...candidate,
			id: "other",
			action: "No reduction established" as const,
			assessment: "review-required" as const,
		},
	];
	it("combines category and case-insensitive name/package/action search without changing analysis", () => {
		expect(filterFindings(findings, { category: "Make file-local", query: " PKG " })).toEqual([
			candidate,
		]);
		expect(filterFindings(findings, { category: "", query: "REVIEW" })).toEqual([findings[1]]);
		expect(
			filterFindings(findings, { category: "No reduction established", query: "missing" }),
		).toEqual([]);
		expect(filterFindings(findings, { category: "", query: "" })).toEqual(findings);
		expect(findings).toHaveLength(2);
	});
});

describe("findings export", () => {
	it("exports all matching rows beyond the UI limit, with deduplicated evidence and metadata", () => {
		const findings = Array.from({ length: 70 }, (_, i) => ({ ...candidate, id: `helper-${i}` }));
		const filters = { category: "Make file-local" as const, query: "helper" };
		const parts = findingsExportParts(snapshot, filterFindings(findings, filters), filters);
		const exported = JSON.parse(parts.join(""));
		expect(exported).toMatchObject({
			version: 2,
			filters,
			findingCount: 70,
			repository: snapshot.repository,
			coverage: snapshot.coverage,
			diagnostics: snapshot.diagnostics,
			reportLoadingIncomplete: true,
		});
		expect(exported.findings).toHaveLength(70);
		expect(exported.findings[69]).toMatchObject({
			id: "helper-69",
			usageIds: ["shared"],
			cleanupIds: ["shared"],
		});
		expect(exported.occurrences).toEqual([occurrence]);
		expect(exported.findings[0]).not.toHaveProperty("usages");
	});
	it("serializes shared large evidence once and in separate chunks", () => {
		const large = { ...occurrence, snippet: "x".repeat(1_000_000) };
		const findings = Array.from({ length: 600 }, (_, i) => ({
			...candidate,
			id: String(i),
			usages: [large],
			cleanup: [],
		}));
		// The previous monolithic export repeated this snippet >600MB, exceeding V8's string limit.
		const parts = findingsExportParts(snapshot, findings, { category: "", query: "" });
		expect(parts.filter((part) => part.includes(large.snippet))).toHaveLength(1);
		expect(parts.reduce((sum, part) => sum + part.length, 0)).toBeLessThan(2_000_000);
		expect(Math.max(...parts.map((part) => part.length))).toBeLessThan(1_010_000);
	});
	it("emits valid JSON for no matches", () => {
		const exported = JSON.parse(
			findingsExportParts(snapshot, [], { category: "", query: "none" }).join(""),
		);
		expect(exported.findings).toEqual([]);
		expect(exported.occurrences).toEqual([]);
		expect(exported.findingCount).toBe(0);
	});
});
