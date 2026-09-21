import type { Assessment, Candidate, Constraint, ProposedChange } from "./candidates";
import type { Occurrence, Snapshot } from "./model";

/** @internal Filters affect presentation/export only, never candidate analysis. */
export interface FindingFilters {
	query?: string;
	category?: Candidate["action"] | "";
	change?: ProposedChange | "";
	assessment?: Assessment | "";
	constraint?: Constraint["code"] | "";
	package?: string;
	scope?: string;
}

/** @internal */
export function filterFindings(findings: Candidate[], filters: FindingFilters): Candidate[] {
	const query = (filters.query ?? "").trim().toLowerCase();
	return findings.filter(
		(finding) =>
			(!filters.category || finding.action === filters.category) &&
			(!filters.change || finding.proposedChange === filters.change) &&
			(!filters.assessment || finding.assessment === filters.assessment) &&
			(!filters.constraint || finding.constraints.some((c) => c.code === filters.constraint)) &&
			(!filters.package ||
				finding.declaringPackage === filters.package ||
				finding.node.package === filters.package ||
				finding.routes.some((r) => r.package === filters.package)) &&
			(!filters.scope || finding.observedUsage.includes(filters.scope)) &&
			`${finding.node.label} ${finding.node.package} ${finding.action} ${finding.assessment}`
				.toLowerCase()
				.includes(query),
	);
}

/** @internal Shared detail/export representation; evidence is normalized by occurrence ID. */
export function findingRecord(finding: Candidate) {
	const { usages, cleanup, ...metadata } = finding;
	return { ...metadata, usageIds: usages.map((o) => o.id), cleanupIds: cleanup.map((o) => o.id) };
}

/** @internal Versioned, normalized JSON. Serialize records separately to avoid the JS string limit. */
export function findingsExportParts(
	snapshot: Snapshot,
	findings: Candidate[],
	filters: FindingFilters,
	analysisId?: string,
): string[] {
	const occurrences = new Map<string, Occurrence>();
	const parts = [
		JSON.stringify({
			version: 2,
			analysisId,
			repository: snapshot.repository,
			generatedAt: snapshot.generatedAt,
			reports: snapshot.reports ?? [],
			coverage: snapshot.coverage,
			reportLoadingIncomplete: snapshot.reportLoadingIncomplete ?? false,
			filters,
			findingCount: findings.length,
		}).slice(0, -1),
		',"findings":[',
	];
	for (const [i, finding] of findings.entries()) {
		for (const occurrence of [...finding.usages, ...finding.cleanup])
			occurrences.set(occurrence.id, occurrence);
		if (i) parts.push(",");
		parts.push(JSON.stringify(findingRecord(finding)));
	}
	parts.push('],"occurrences":[');
	let first = true;
	for (const occurrence of occurrences.values()) {
		if (!first) parts.push(",");
		first = false;
		parts.push(JSON.stringify(occurrence));
	}
	parts.push('],"diagnostics":[');
	for (const [i, diagnostic] of snapshot.diagnostics.entries()) {
		if (i) parts.push(",");
		parts.push(JSON.stringify(diagnostic));
	}
	parts.push("]}\n");
	return parts;
}
