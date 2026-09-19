import { describe, expect, it } from "vitest";
import { internalDependencies } from "../src/internal-dependencies";
import type { ApiNode, Snapshot } from "../src/model";

function fixture(): Snapshot {
	const api: ApiNode = {
		id: "internal",
		label: "helper",
		kind: "function",
		package: "core",
		entry: ".",
		release: "internal",
		implementationId: "helper-implementation",
		source: { path: "src/api.ts", line: 1, column: 1, snippet: "helper" },
	};
	return {
		version: 1,
		repository: { id: "catalog", name: "leitwerk", revision: "abc", dirty: false },
		generatedAt: "now",
		coverage: {
			complete: true,
			sourceFiles: 1,
			entryPoints: 1,
			extractedEntryPoints: 1,
			typescriptVersion: "6",
			limitations: [],
		},
		reports: ["catalog", "consumer"].map((id) => ({
			id,
			name: id === "consumer" ? "leitwerk-rsnc" : "leitwerk",
			revision: "abc",
			fingerprint: "fp",
			producerVersion: "1",
			analyzedPackages: { core: "1" },
			compatible: true,
			complete: true,
		})),
		nodes: [
			api,
			{ ...api, id: "public", release: "public", entry: "./public" },
			{ id: "caller", kind: "file", label: "caller", package: "extension" },
		],
		occurrences: [
			{
				id: "call",
				reportId: "consumer",
				fileId: "caller",
				kind: "call",
				targets: ["internal", "public"],
				routeTargets: ["internal"],
				targetPackages: ["core"],
				isTest: false,
				path: "src/caller.ts",
				line: 4,
				column: 1,
				snippet: "helper()",
			},
		],
		relationships: [],
		diagnostics: [],
	};
}

describe("internal API dependencies", () => {
	it("warns on resolved external internal routes and preserves source evidence", () => {
		const snapshot = fixture();
		const [finding] = internalDependencies(snapshot);
		expect(finding).toMatchObject({
			repository: "leitwerk-rsnc",
			consumerPackage: "extension",
			targetPackage: "core",
			assessment: "warning",
			reasons: [],
			consumerVersion: "1",
			catalogVersion: "1",
		});
		expect(finding.usages).toEqual(snapshot.occurrences);
	});
	it("does not attribute an explicitly public route to an internal alias", () => {
		const snapshot = fixture();
		snapshot.occurrences[0].routeTargets = ["public"];
		expect(internalDependencies(snapshot)).toEqual([]);
	});
	it("marks ambiguous aliases as needs review and deduplicates shared routes and occurrences", () => {
		const snapshot = fixture();
		snapshot.nodes.push({ ...snapshot.nodes[0], id: "alias", entry: "./alias" });
		snapshot.occurrences[0].routeTargets = [];
		snapshot.occurrences[0].targets.push("alias");
		snapshot.occurrences.push({ ...snapshot.occurrences[0] });
		const findings = internalDependencies(snapshot);
		expect(findings).toHaveLength(1);
		expect(findings[0].assessment).toBe("needs-review");
		expect(findings[0].routes).toHaveLength(2);
		expect(findings[0].usages).toHaveLength(1);
	});
	it("does not merge distinct members sharing a legacy implementation identity", () => {
		const snapshot = fixture();
		snapshot.nodes.push({
			...snapshot.nodes[0],
			id: "other",
			qualifiedName: "Other.helper",
			source: { path: "src/api.ts", line: 20, column: 1, snippet: "helper" },
		});
		snapshot.occurrences.push({
			...snapshot.occurrences[0],
			id: "other-call",
			targets: ["other"],
			routeTargets: ["other"],
		});
		expect(internalDependencies(snapshot)).toHaveLength(2);
	});
	it("compares the target package version, not unrelated package versions", () => {
		const snapshot = fixture();
		const consumer = snapshot.reports?.[1];
		if (!consumer) throw new Error("fixture missing consumer");
		consumer.compatible = false;
		consumer.analyzedPackages.other = "99";
		expect(internalDependencies(snapshot)[0].assessment).toBe("warning");
		consumer.analyzedPackages.core = "2";
		expect(internalDependencies(snapshot)[0].reasons).toContain(
			"Package versions differ: consumer 2, catalog 1.",
		);
		delete consumer.analyzedPackages.core;
		expect(internalDependencies(snapshot)[0].assessment).toBe("needs-review");
	});
	it("ignores same-package references and aliases from other packages", () => {
		const snapshot = fixture();
		snapshot.nodes[2].package = "core";
		expect(internalDependencies(snapshot)).toEqual([]);
		snapshot.nodes[2].package = "extension";
		snapshot.occurrences[0].targetPackages = ["other"];
		expect(internalDependencies(snapshot)).toEqual([]);
	});
	it("keeps production, test, import, and type evidence despite incomplete coverage", () => {
		const snapshot = fixture();
		snapshot.coverage.complete = false;
		snapshot.occurrences.push({
			...snapshot.occurrences[0],
			id: "type",
			kind: "type",
			isTest: true,
		});
		snapshot.occurrences.push({ ...snapshot.occurrences[0], id: "import", kind: "import" });
		const findings = internalDependencies(snapshot);
		expect(findings).toHaveLength(1);
		expect(findings[0].usages).toHaveLength(3);
		expect(findings[0].assessment).toBe("warning");
	});
	it("does not treat absent reports or consumer ownership as certain", () => {
		const snapshot = fixture();
		delete snapshot.reports;
		snapshot.nodes = snapshot.nodes.filter((n) => n.id !== "caller");
		expect(internalDependencies(snapshot)[0]).toMatchObject({
			assessment: "needs-review",
			consumerPackage: "(unknown)",
		});
	});
});
