import { expect, it } from "vitest";
import { removalCandidates } from "../src/candidates";
import { findingsFixture } from "./fixtures/findings";

it.each([
	"public",
	"alpha",
	"beta",
	undefined,
])("holds local and test-consumed %s APIs for release review", (release) => {
	const s = findingsFixture();
	s.nodes[1].release = release;
	for (const isTest of [false, true]) {
		s.occurrences[0].isTest = isTest;
		const f = removalCandidates(s)[0];
		expect(f.assessment).toBe("review-required");
		expect(
			f.constraints.some(
				(c) => c.code === (release ? "compatibility-contract" : "unknown-release"),
			),
		).toBe(true);
	}
});
it("protects declared dynamic runtime entries even with test consumers; default alone is uncertainty", () => {
	const s = findingsFixture();
	s.occurrences[0].isTest = true;
	s.nodes[1].evidence = [
		{ kind: "default-export", label: "default", detail: "default", source: s.nodes[1].source! },
	];
	expect(removalCandidates(s)[0].assessment).toBe("review-required");
	expect(removalCandidates(s)[0].constraints.some((c) => c.code === "runtime-entry")).toBe(false);
	s.nodes[1].evidence.push({ ...s.nodes[1].evidence[0], kind: "extension-entry" });
	const f = removalCandidates(s)[0];
	expect(f.assessment).toBe("retain");
	expect(f.declarationAssessment).toBe("retain");
	expect(f.observedUsage).toContain("only-test-consumers-observed");
});
it("names retaining signatures but does not protect every barrel route", () => {
	const s = findingsFixture();
	s.occurrences = [];
	s.nodes.push({
		id: "owner",
		label: "Owner",
		qualifiedName: "Owner.run",
		kind: "method",
		package: "pkg",
	});
	s.relationships.push({ from: "owner", to: "helper", kind: "type" });
	const f = removalCandidates(s)[0];
	expect(f.retainingApiIds).toEqual(["owner"]);
	expect(f.reason).toContain("Owner.run");
	expect(f.declarationAssessment).toBe("retain");
	expect(f.proposedChange).toBe("reduce-package-exposure");
	expect(f.assessment).toBe("candidate");
});
it.each([
	"production",
	"test",
	"import",
	"none",
	"mixed-route",
])("gates absence-based %s proposals on coverage", (mode) => {
	const s = findingsFixture();
	if (mode === "test") s.occurrences[0].isTest = true;
	if (mode === "import") s.occurrences[0].kind = "import";
	if (mode === "none") s.occurrences = [];
	if (mode === "mixed-route") {
		s.nodes[1].implementationId = "impl";
		s.nodes.push({ ...s.nodes[1], id: "alias", entry: "./other" });
		s.nodes[2].package = "consumer";
		s.occurrences[0].routeTargets = ["helper"];
	}
	for (const incomplete of ["catalog", "loading", "consumer"] as const) {
		const copy = structuredClone(s);
		if (incomplete === "catalog") copy.coverage.complete = false;
		if (incomplete === "loading") copy.reportLoadingIncomplete = true;
		if (incomplete === "consumer")
			copy.reports = [
				{
					id: "consumer",
					name: "Consumer",
					revision: "r",
					fingerprint: "f",
					producerVersion: "1",
					analyzedPackages: {},
					compatible: false,
					complete: false,
				},
			];
		const f = removalCandidates(copy)[0];
		expect(f.assessment).toBe("review-required");
		expect(f.constraints.some((c) => c.code === "incomplete-coverage")).toBe(true);
		expect(
			f.routes.every((r) => r.assessment === "review-required" || r.assessment === "retain"),
		).toBe(true);
	}
});
it("scopes public and runtime retention to their route, and groups aliases deterministically", () => {
	const s = findingsFixture();
	s.nodes[1].implementationId = "impl";
	s.nodes[1].release = "public";
	s.nodes[1].keepReasons = ["Loaded by name"];
	s.nodes.push({
		...s.nodes[1],
		id: "alias",
		entry: "./internal",
		release: "internal",
		keepReasons: [],
	});
	const f = removalCandidates(s)[0];
	expect(f.routes.find((r) => r.id === "helper")?.assessment).toBe("retain");
	expect(f.routes.find((r) => r.id === "alias")?.assessment).toBe("candidate");
	expect(f.proposedChange).toBe("reduce-package-exposure");
	expect(f.declarationAssessment).toBe("retain");
	s.nodes.reverse();
	expect(removalCandidates(s)).toEqual([f]);
});
it("never recommends file-local reduction while a public alias still needs compatibility review", () => {
	const s = findingsFixture();
	s.nodes[1].implementationId = "impl";
	s.nodes[1].release = "public";
	s.nodes.push({ ...s.nodes[1], id: "alias", entry: "./internal", release: "internal" });
	const f = removalCandidates(s)[0];
	expect(f.proposedChange).toBe("reduce-package-exposure");
	expect(f.assessment).toBe("candidate");
	expect(f.routes.find((r) => r.id === "helper")?.assessment).toBe("review-required");
	expect(f.routes.find((r) => r.id === "alias")?.assessment).toBe("candidate");
});
it("reports import migration and direct-source facades without proposing declaration removal", () => {
	const s = findingsFixture();
	s.nodes[0].source = s.nodes[1].source;
	s.occurrences[0] = {
		...s.occurrences[0],
		path: "pkg/test.ts",
		kind: "import",
		isTest: true,
		routeTargets: ["helper"],
	};
	const f = removalCandidates(s)[0];
	expect(f.proposedChange).toBe("reduce-package-exposure");
	expect(f.assessment).toBe("migration-required");
	expect(f.declarationAssessment).toBe("retain");
	expect(f.routes[0].migrationRequirements.map((m) => m.code)).toEqual([
		"rewrite-same-package-imports",
		"preserve-module-access",
		"separate-entry-facade",
	]);
	expect(f.routes[0].migrationRequirements[0].occurrenceIds).toEqual(["call"]);
});
it("side effects block deletion, not unused exposure; deletion otherwise requires no consumers", () => {
	const s = findingsFixture();
	s.occurrences = [];
	expect(removalCandidates(s)[0].proposedChange).toBe("consider-declaration-deletion");
	s.nodes[1].sideEffects = true;
	const f = removalCandidates(s)[0];
	expect(f.proposedChange).toBe("reduce-package-exposure");
	expect(f.declarationAssessment).toBe("review-required");
	expect(f.assessment).toBe("candidate");
});
it("does not infer route absence from partially resolved targets or missing consumer metadata", () => {
	const s = findingsFixture();
	s.nodes[1].implementationId = "impl";
	s.nodes.push({ ...s.nodes[1], id: "alias", entry: "./other" });
	s.nodes[2].package = "consumer";
	s.occurrences[0].routeTargets = ["helper", "unknown-route"];
	const f = removalCandidates(s)[0];
	expect(f.routes.find((r) => r.id === "helper")?.assessment).toBe("retain");
	expect(f.routes.find((r) => r.id === "alias")?.assessment).toBe("review-required");
	s.occurrences[0].fileId = "missing";
	expect(removalCandidates(s)[0].constraints.some((c) => c.code === "unknown-consumer")).toBe(true);
});
