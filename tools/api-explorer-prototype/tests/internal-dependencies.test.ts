import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import InternalDependencies from "../src/InternalDependencies.svelte";
import {
	hasCompleteConsumerSourceMetadata,
	internalDependencies,
} from "../src/internal-dependencies";
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
			{
				id: "core-package",
				kind: "package",
				label: "core",
				package: "core",
				source: { path: "packages/domain/package.json", line: 1, column: 1, snippet: "" },
			},
			{
				id: "extension-package",
				kind: "package",
				label: "extension",
				package: "extension",
				source: { path: "extensions/telegram/package.json", line: 1, column: 1, snippet: "" },
			},
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
				sourceOrigin: "workspace",
			},
		],
		relationships: [],
		diagnostics: [],
	};
}

describe("internal API dependencies", () => {
	it("shows only confirmed violations with search and API package controls", () => {
		const snapshot = fixture();
		snapshot.nodes[4].source!.path = "packages/server/package.json";
		snapshot.occurrences.push(
			{ ...snapshot.occurrences[0], id: "allowed", reportId: "catalog" },
			{ ...snapshot.occurrences[0], id: "uncertain", sourceOrigin: undefined },
		);
		const { body } = render(InternalDependencies, { props: { snapshot, open: () => {} } });
		expect(body).toContain("1 violation.");
		expect(body).toContain("Export violations (1)");
		expect(body).toContain("Some references could not be assessed");
		expect(body).not.toContain("Allowed internal dependency");
		expect(body).not.toContain("Needs review");
		expect(body).toContain("API package<select");
		expect(body).toContain("<option>core</option>");
		expect(body).not.toContain("Consumer repository");
		expect(body.match(/<select/g)).toHaveLength(1);
		expect(body.match(/<article/g)).toHaveLength(1);
	});
	it.each([
		{ sourceOrigin: "composition", path: "vendor/core/extensions/caller.ts" },
		{ sourceOrigin: undefined, path: ".leitwerk-base/extensions/caller.ts" },
		{ sourceOrigin: "workspace", path: "./.leitwerk-base/extensions/caller.ts" },
	] as const)("excludes base sources before classification: %j", (source) => {
		const snapshot = fixture();
		Object.assign(snapshot.occurrences[0], source);
		expect(internalDependencies(snapshot)).toEqual([]);
		const { body } = render(InternalDependencies, { props: { snapshot, open: () => {} } });
		expect(body).toContain("Export violations (0)");
		expect(body).not.toContain("Some references could not be assessed");
		expect(body).not.toContain("<article");
	});
	it("retains catalog and external callers while excluding their composed repetitions", () => {
		const snapshot = fixture();
		const base = snapshot.occurrences[0];
		snapshot.occurrences.push(
			{ ...base, id: "catalog", reportId: "catalog" },
			{
				...base,
				id: "copy",
				sourceOrigin: "composition",
				path: ".leitwerk-base/extensions/caller.ts",
			},
		);
		const findings = internalDependencies(snapshot);
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.consumerSource).sort()).toEqual(["catalog", "workspace"]);
		expect(findings.every((f) => f.assessment === "forbidden")).toBe(true);
		// Exclusion is about the caller, not the declaration being resolved.
		snapshot.nodes[0].source!.path = ".leitwerk-base/packages/domain/src/api.ts";
		expect(internalDependencies(snapshot)).toHaveLength(2);
	});
	it("does not count uncertain evidence as a violation in the empty state", () => {
		const snapshot = fixture();
		delete snapshot.occurrences[0].sourceOrigin;
		const { body } = render(InternalDependencies, { props: { snapshot, open: () => {} } });
		expect(body).toContain("0 violations.");
		expect(body).toContain("No confirmed internal API violations in the loaded evidence.");
		expect(body).not.toContain("<article");
	});
	it("applies the boundary matrix to catalog sources in production and tests", () => {
		for (const consumer of ["core", "extension"] as const) {
			for (const target of ["core", "extension"] as const) {
				for (const isTest of [false, true]) {
					const snapshot = fixture();
					snapshot.nodes[2].package = "consumer";
					snapshot.nodes.push({
						id: "consumer-package",
						kind: "package",
						package: "consumer",
						label: "consumer",
						source: {
							path: `${consumer === "core" ? "packages" : "extensions"}/consumer/package.json`,
							line: 1,
							column: 1,
							snippet: "",
						},
					});
					snapshot.nodes[3].source!.path =
						`${target === "core" ? "packages" : "extensions"}/domain/package.json`;
					Object.assign(snapshot.occurrences[0], {
						reportId: "catalog",
						sourceOrigin: "workspace",
						isTest,
					});
					const [finding] = internalDependencies(snapshot);
					expect(finding).toMatchObject({
						consumerOwnership: consumer,
						targetOwnership: target,
						assessment: consumer === "core" && target === "core" ? "allowed" : "forbidden",
					});
				}
			}
		}
	});
	it("does not grant catalog privileges to same-named external packages", () => {
		const snapshot = fixture();
		snapshot.nodes[2].package = "core";
		expect(internalDependencies(snapshot)[0]).toMatchObject({
			consumerOwnership: "external",
			assessment: "forbidden",
		});
	});
	it("keeps repository-level and legacy consumers unresolved", () => {
		const snapshot = fixture();
		snapshot.nodes[2].package = "(repository)";
		snapshot.occurrences[0].reportId = "catalog";
		expect(internalDependencies(snapshot)[0].boundaryDecision).toBe("unresolved");
		snapshot.nodes[2].package = "core";
		snapshot.occurrences[0].reportId = "consumer";
		delete snapshot.occurrences[0].sourceOrigin;
		expect(internalDependencies(snapshot)[0].assessment).toBe("needs-review");
	});
	it("requires catalog roots and retains version uncertainty independently of policy", () => {
		const snapshot = fixture();
		snapshot.occurrences[0].reportId = "catalog";
		snapshot.nodes[4].source!.path = "packages/server/package.json";
		snapshot.reports![0].analyzedPackages.core = "unknown";
		expect(internalDependencies(snapshot)[0]).toMatchObject({
			boundaryDecision: "allowed",
			assessment: "needs-review",
		});
		snapshot.nodes[3].source!.path = "vendor/packages/domain/package.json";
		expect(internalDependencies(snapshot)[0].boundaryDecision).toBe("unresolved");
	});
	it("forbids resolved external internal routes and preserves source evidence", () => {
		const snapshot = fixture();
		const [finding] = internalDependencies(snapshot);
		expect(finding).toMatchObject({
			repository: "leitwerk-rsnc",
			consumerPackage: "extension",
			targetPackage: "core",
			assessment: "forbidden",
			reasons: [],
			consumerSource: "workspace",
			consumerVersion: "1",
			catalogVersion: "1",
		});
		expect(finding.usages).toEqual(snapshot.occurrences);
	});
	it("classifies relevant sources separately and excludes composition evidence", () => {
		const snapshot = fixture();
		const base = snapshot.occurrences[0];
		snapshot.occurrences.push(
			{ ...base, id: "composed", sourceOrigin: "composition" },
			{ ...base, id: "legacy", sourceOrigin: undefined },
			{ ...base, id: "catalog", reportId: "catalog", sourceOrigin: "workspace" },
		);
		const findings = internalDependencies(snapshot);
		expect(new Set(findings.map((finding) => finding.consumerSource))).toEqual(
			new Set(["workspace", "unknown", "catalog"]),
		);
		expect(findings).toHaveLength(3);
		expect(hasCompleteConsumerSourceMetadata(snapshot)).toBe(false);
		snapshot.occurrences = snapshot.occurrences.filter((occurrence) => occurrence.id !== "legacy");
		expect(hasCompleteConsumerSourceMetadata(snapshot)).toBe(true);
		snapshot.occurrences = snapshot.occurrences.filter(
			(occurrence) => occurrence.reportId !== "consumer",
		);
		expect(hasCompleteConsumerSourceMetadata(snapshot)).toBe(false);
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
		expect(internalDependencies(snapshot)[0].assessment).toBe("forbidden");
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
		snapshot.occurrences[0].reportId = "catalog";
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
		expect(findings[0].assessment).toBe("forbidden");
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
