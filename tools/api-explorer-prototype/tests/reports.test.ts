import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSnapshot } from "../scripts/indexer.mjs";
import { loadReports, type Report } from "../scripts/reports";
import { removalCandidates } from "../src/candidates";
import type { Snapshot } from "../src/model";
import { makeNote, mergeNotes } from "../src/notes";

const dirs: string[] = [];
const temp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "api-reports-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const location = { path: "src/helper.ts", line: 118, column: 1, snippet: "helper()" };
function fixture(): Report {
	return {
		schemaVersion: 1,
		producerVersion: "0.2.0",
		kind: "catalog",
		source: { id: "main", name: "Main", revision: "rev", fingerprint: "content" },
		analyzedPackages: { pkg: "1" },
		snapshot: {
			version: 1,
			repository: { id: "main", name: "Main", revision: "rev", dirty: false },
			generatedAt: "2026-01-01",
			coverage: {
				complete: true,
				sourceFiles: 2,
				entryPoints: 1,
				extractedEntryPoints: 1,
				typescriptVersion: "6",
				limitations: [],
			},
			nodes: [
				{ id: "entry", label: ".", kind: "entry", package: "pkg" },
				{
					id: "helper",
					label: "helper",
					qualifiedName: "helper",
					kind: "function",
					package: "pkg",
					entry: ".",
					parentId: "entry",
					source: location,
					release: "internal",
				},
				{ id: "file", kind: "file", label: "helper.ts", package: "pkg", source: location },
			],
			occurrences: [
				{
					...location,
					id: "call",
					fileId: "file",
					targets: ["helper"],
					kind: "call",
					isTest: false,
				},
			],
			relationships: [],
			diagnostics: [],
		},
	};
}
function put(dir: string, name: string, value: unknown) {
	fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}
it("loads portable snippets and stable note identities without accessing source files", () => {
	const dir = temp(),
		report = fixture();
	put(dir, "catalog.json", report);
	const result = loadReports(dir),
		candidate = removalCandidates(result)[0];
	expect(candidate.action).toBe("Make file-local");
	expect(candidate.usages[0].line).toBe(118);
	const node = result.nodes.find((n) => n.id === "helper")!;
	const note = makeNote(node, "Keep local call");
	expect(mergeNotes({ [node.id]: note }, {})[node.id].text).toBe("Keep local call");
	expect(result.occurrences[0].snippet).toBe("helper()");
});
it("diagnoses empty, malformed, and incompatible directories", () => {
	const dir = temp();
	expect(loadReports(dir).coverage.complete).toBe(false);
	fs.writeFileSync(path.join(dir, "bad.json"), "{");
	put(dir, "future.json", { schemaVersion: 9 });
	expect(loadReports(dir).diagnostics).toHaveLength(3);
});
it("deduplicates sources, replaces older evidence, and retains mismatched positive usages", () => {
	const dir = temp();
	put(dir, "catalog.json", fixture());
	const usage = fixture();
	usage.kind = "usage";
	usage.source.id = "consumer";
	usage.source.name = "Consumer";
	usage.analyzedPackages.pkg = "2";
	usage.snapshot.nodes.find((n) => n.id === "file")!.package = "consumer";
	put(dir, "usage-old.json", usage);
	usage.snapshot.generatedAt = "2026-02-01";
	usage.snapshot.occurrences[0].snippet = "new helper()";
	put(dir, "usage-new.json", usage);
	put(dir, "duplicate.json", usage);
	const merged = loadReports(dir);
	expect(merged.reports).toHaveLength(2);
	expect(merged.occurrences).toHaveLength(2);
	expect(merged.occurrences[1].snippet).toBe("new helper()");
	expect(merged.coverage.complete).toBe(false);
	expect(removalCandidates(merged)[0].assessment).toBe("review-required");
});
it("counts import-only test consumers and separates exposure from deletion blockers", () => {
	const report = fixture(),
		s = report.snapshot;
	s.occurrences[0].isTest = true;
	expect(removalCandidates(s)[0].observedUsage).toContain("only-test-consumers-observed");
	s.occurrences[0].kind = "import";
	expect(removalCandidates(s)[0].declarationAssessment).toBe("retain");
	s.nodes[1].sideEffects = true;
	expect(removalCandidates(s)[0].constraints).toContainEqual(
		expect.objectContaining({ code: "side-effects", appliesTo: "declaration-deletion" }),
	);
	s.nodes[1].sideEffects = false;
	s.nodes[1].keepReasons = ["Runtime callback"];
	expect(removalCandidates(s)[0].assessment).toBe("retain");
});
it("preserves signatures, members, aliases, and internal imports", () => {
	const s = fixture().snapshot;
	s.nodes[2].source = { ...location, path: "src/other.ts" };
	s.occurrences[0].path = "src/other.ts";
	expect(removalCandidates(s)[0].action).toBe("Reduce package exposure");
	s.relationships.push({ from: "retained", to: "helper", kind: "type" });
	expect(removalCandidates(s)[0].retainingApiIds).toEqual(["retained"]);
	expect(removalCandidates(s)[0].declarationAssessment).toBe("retain");
	s.relationships = [];
	s.nodes[1].implementationId = "impl";
	s.nodes.push({ ...s.nodes[1], id: "alias", label: "alias", entry: "./alternate" });
	s.nodes.push({ id: "member", parentId: "helper", kind: "method", label: "run", package: "pkg" });
	s.occurrences[0].targets = ["member"];
	expect(removalCandidates(s)).toHaveLength(1);
	expect(removalCandidates(s)[0].routes).toHaveLength(2);
});
it("honors supplemental keep reasons and cannot infer absence from empty reports", () => {
	const dir = temp();
	put(dir, "catalog.json", fixture());
	const keep = fixture();
	keep.kind = "supplemental";
	keep.source.id = "runtime";
	keep.snapshot.occurrences = [];
	keep.snapshot.coverage.sourceFiles = 0;
	keep.keep = [{ target: "helper", reason: "Loaded by name" }];
	put(dir, "runtime.json", keep);
	expect(removalCandidates(loadReports(dir))[0].reason).toContain("Loaded by name");
	expect(loadReports(dir).coverage.complete).toBe(false);
});
it("ignores report output in git", () => {
	const root = path.resolve(import.meta.dirname, "../../..");
	expect(
		execFileSync("git", ["check-ignore", ".leitwerk/api-explorer/reports/catalog.json"], {
			cwd: root,
			encoding: "utf8",
		}).trim(),
	).toBe(".leitwerk/api-explorer/reports/catalog.json");
});
it("requires compatibility review for public/preview tags and has no display-filter input", () => {
	const s = fixture().snapshot;
	const assessments = ["public", "alpha", "beta", "internal"].map((release) => {
		s.nodes[1].release = release;
		return removalCandidates(s)[0].assessment;
	});
	expect(assessments).toEqual([
		"review-required",
		"review-required",
		"review-required",
		"candidate",
	]);
	const before = removalCandidates(s);
	const filtered: Snapshot = { ...s };
	expect(removalCandidates(filtered)).toEqual(before);
});

it("keeps the real failed-turn recovery helper local call at line 118", async () => {
	const root = temp(),
		checkout = path.resolve(import.meta.dirname, "../../..");
	const directory = path.join(root, "packages/domain");
	fs.mkdirSync(path.join(directory, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}');
	fs.writeFileSync(
		path.join(directory, "package.json"),
		JSON.stringify({
			name: "@leitwerk-dev/domain",
			exports: { ".": { source: "./src/index.ts", types: "./dist/index.d.ts" } },
		}),
	);
	fs.copyFileSync(
		path.join(checkout, "packages/domain/src/turn-recovery.ts"),
		path.join(directory, "src/turn-recovery.ts"),
	);
	fs.writeFileSync(
		path.join(directory, "src/index.ts"),
		'export { isFailedTurnRecoveryCode } from "./turn-recovery.js";',
	);
	const snapshot = (await createSnapshot(root, path.join(root, "output"), {
		extract: false,
	})) as Snapshot;
	const finding = removalCandidates(snapshot).find(
		(f) => f.node.label === "isFailedTurnRecoveryCode",
	);
	// Extraction was disabled, so even an observed local call cannot establish absence.
	expect(finding?.assessment).toBe("review-required");
	expect(finding?.usages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "call",
				line: 118,
				path: "packages/domain/src/turn-recovery.ts",
			}),
		]),
	);
});

it("retains used alias routes while proposing unused exposure removal", () => {
	const s = fixture().snapshot;
	s.nodes[1].implementationId = "implementation";
	s.nodes.push({ ...s.nodes[1], id: "alias", label: "alias", entry: "./other" });
	s.nodes[2].package = "consumer";
	s.occurrences[0].routeTargets = ["helper"];
	const finding = removalCandidates(s)[0];
	expect(finding.action).toBe("Reduce package exposure");
	expect(finding.routes.find((r) => r.id === "helper")?.assessment).toBe("retain");
	expect(finding.routes.find((r) => r.id === "alias")?.assessment).toBe("candidate");
});
it("keeps module exports needed by same-package tests, even with only file-local production calls", () => {
	const s = fixture().snapshot;
	s.occurrences.push({ ...s.occurrences[0], id: "test", path: "src/helper.test.ts", isTest: true });
	const finding = removalCandidates(s)[0];
	expect(finding.action).toBe("Reduce package exposure");
	expect(finding.reason).toContain("Keep the module export");
	expect(finding.routes[0].assessment).toBe("migration-required");
});
it("retains cross-package testing exports even with file-local production calls", () => {
	const s = fixture().snapshot;
	s.nodes.push({ id: "test-file", label: "test", kind: "file", package: "consumer" });
	s.occurrences.push({
		...s.occurrences[0],
		id: "test",
		fileId: "test-file",
		path: "consumer/test.ts",
		isTest: true,
		routeTargets: ["helper"],
	});
	const finding = removalCandidates(s)[0];
	expect(finding.assessment).toBe("retain");
	expect(finding.routes[0]).toMatchObject({
		used: true,
		testUsed: true,
		productionUsed: false,
		action: "Retain export",
	});
	// Import-only consumers must not silently lose their route either.
	s.occurrences[1].kind = "import";
	expect(removalCandidates(s)[0].assessment).toBe("retain");
});
it("protects test-used aliases, including exports with no production callers", () => {
	const s = fixture().snapshot;
	s.nodes[1].implementationId = "implementation";
	s.nodes.push({ ...s.nodes[1], id: "alias", entry: "./testing" });
	s.nodes[2].package = "consumer";
	s.occurrences[0].isTest = true;
	s.occurrences[0].routeTargets = ["alias"];
	const finding = removalCandidates(s)[0];
	expect(finding.action).toBe("Reduce package exposure");
	expect(finding.routes.find((r) => r.id === "helper")?.assessment).toBe("candidate");
	expect(finding.routes.find((r) => r.id === "alias")?.assessment).toBe("retain");
	delete s.occurrences[0].routeTargets;
	expect(removalCandidates(s)[0].assessment).toBe("review-required");
	expect(removalCandidates(s)[0].routes.every((r) => r.assessment === "review-required")).toBe(
		true,
	);
});
it("retains both production-used and test-used routes", () => {
	const s = fixture().snapshot;
	s.nodes[1].implementationId = "implementation";
	s.nodes.push({ ...s.nodes[1], id: "alias", entry: "./testing" });
	s.nodes[2].package = "consumer";
	s.occurrences[0].routeTargets = ["helper"];
	s.occurrences.push({ ...s.occurrences[0], id: "test", isTest: true, routeTargets: ["alias"] });
	expect(removalCandidates(s)[0].assessment).toBe("retain");
	expect(removalCandidates(s)[0].routes.every((r) => r.assessment === "retain")).toBe(true);
});
it("does not treat an out-of-file import as file-local", () => {
	const s = fixture().snapshot;
	s.occurrences.push({ ...s.occurrences[0], id: "import", path: "src/other.ts", kind: "import" });
	expect(removalCandidates(s)[0].action).toBe("Reduce package exposure");
});
it("rejects malformed nested evidence without crashing report loading", () => {
	const dir = temp(),
		report = fixture();
	put(dir, "catalog.json", report);
	put(dir, "bad.json", {
		...report,
		kind: "usage",
		snapshot: { ...report.snapshot, nodes: [{ ...report.snapshot.nodes[1], evidence: {} }] },
	});
	const merged = loadReports(dir);
	expect(merged.reportLoadingIncomplete).toBe(true);
	expect(removalCandidates(merged)[0].assessment).toBe("review-required");
});
