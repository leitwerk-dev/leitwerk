import type { ApiNode, Occurrence, Snapshot } from "./model";

/** @internal Source ownership is independent of report/composition provenance. */
export type SourceOwnership = "core" | "extension" | "external" | "unknown";

/** @internal Catalog package roots establish ownership, including for composed copies. */
function catalogOwnership(snapshot: Snapshot, packageName: string): SourceOwnership {
	const roots = snapshot.nodes.filter((node) => node.kind === "package" && node.package === packageName);
	if (roots.length !== 1) return "unknown";
	const path = roots[0].source?.path;
	if (path && /^packages\/[^/]+\/package\.json$/.test(path)) return "core";
	if (path && /^extensions\/[^/]+\/package\.json$/.test(path)) return "extension";
	return "unknown";
}

/** @internal Advisory policy assessment, not CI enforcement or proof of runtime execution. */
export interface InternalDependency {
	id: string;
	reportId: string;
	repository: string;
	consumerPackage: string;
	consumerSource: "catalog" | "workspace" | "composition" | "unknown";
	targetPackage: string;
	api: ApiNode;
	routes: ApiNode[];
	consumerOwnership: SourceOwnership;
	targetOwnership: SourceOwnership;
	boundaryDecision: "allowed" | "forbidden" | "unresolved";
	policyReason: string;
	assessment: "allowed" | "forbidden" | "needs-review";
	reasons: string[];
	usages: Occurrence[];
	consumerVersion?: string;
	catalogVersion?: string;
}

/** @internal Legacy and mixed consumer collections must not default-hide evidence. */
export function hasCompleteConsumerSourceMetadata(snapshot: Snapshot): boolean {
	const catalogId = snapshot.repository.id;
	const consumerIds = new Set(
		(snapshot.reports ?? []).filter((report) => report.id !== catalogId).map((report) => report.id),
	);
	return [...consumerIds].every((reportId) => {
		const occurrences = snapshot.occurrences.filter(
			(occurrence) => (occurrence.reportId ?? catalogId) === reportId,
		);
		return occurrences.length > 0 && occurrences.every((occurrence) => occurrence.sourceOrigin);
	});
}

/** @internal Analyze catalog and workspace-owned callers, not composition/base-source repetitions. */
export function internalDependencies(snapshot: Snapshot): InternalDependency[] {
	const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
	const reports = new Map(snapshot.reports?.map((report) => [report.id, report]));
	const catalog = reports.get(snapshot.repository.id);
	const findings = new Map<string, InternalDependency>();
	for (const occurrence of snapshot.occurrences) {
		const reportId = occurrence.reportId ?? snapshot.repository.id;
		// Composed Leitwerk sources are resolution context, not external consumer evidence.
		// The path guard also covers legacy reports without source-origin metadata.
		if (reportId !== snapshot.repository.id && (
			occurrence.sourceOrigin === "composition" ||
			/(^|\/)\.leitwerk-base(\/|$)/.test(occurrence.path)
		)) continue;
		const report = reports.get(reportId);
		const file = nodes.get(occurrence.fileId);
		const consumerSource =
			reportId === snapshot.repository.id ? "catalog" : (occurrence.sourceOrigin ?? "unknown");
		// Prefer the route actually imported, never every alias of its implementation.
		const explicit = occurrence.routeTargets ?? [];
		const targets = [...new Set(explicit.length ? explicit : occurrence.targets)]
			.map((id) => nodes.get(id))
			.filter((node): node is ApiNode => !!node);
		const hasPublicRoute = targets.some((node) => node.release !== "internal");
		for (const target of targets) {
			if (target.release !== "internal") continue;
			if (occurrence.targetPackages?.length && !occurrence.targetPackages.includes(target.package))
				continue;
			const trustedCatalogSource = consumerSource === "catalog";
			const consumerOwnership = consumerSource === "workspace"
				? "external"
				: trustedCatalogSource && file
					? catalogOwnership(snapshot, file.package)
					: "unknown";
			const targetOwnership = catalogOwnership(snapshot, target.package);
			// A workspace package with the same name is not a catalog-owned package.
			if (trustedCatalogSource && consumerOwnership !== "unknown" && file?.package === target.package) continue;
			const boundaryDecision = consumerOwnership === "unknown" || targetOwnership === "unknown"
				? "unresolved"
				: consumerOwnership === "core" && targetOwnership === "core" ? "allowed" : "forbidden";
			const policyReason = boundaryDecision === "unresolved"
				? "Source/package ownership could not be resolved."
				: boundaryDecision === "allowed"
					? "Core packages may depend on other core packages' internal APIs."
					: consumerOwnership === "core"
						? "Core packages must not depend on extensions."
						: "Extensions and external consumers must not depend on another package's internal APIs.";
			const consumerVersion = report?.analyzedPackages[target.package];
			const catalogVersion = catalog?.analyzedPackages[target.package];
			const reasons: string[] = boundaryDecision === "unresolved" ? [policyReason] : [];
			if (
				!explicit.length ||
				explicit.length !== 1 ||
				hasPublicRoute ||
				targets.length !== explicit.length
			)
				reasons.push("The imported API route is ambiguous or unresolved.");
			if (
				!consumerVersion ||
				!catalogVersion ||
				consumerVersion === "unknown" ||
				catalogVersion === "unknown"
			)
				reasons.push("The consumed or catalog package version is unknown.");
			else if (consumerVersion !== catalogVersion)
				reasons.push(
					`Package versions differ: consumer ${consumerVersion}, catalog ${catalogVersion}.`,
				);
			if (!file || file.package === "(repository)")
				reasons.push("The consumer package is unknown.");
			// Deduplicate aliases within a package while retaining the routes for review.
			// implementationId alone can collide for same-named members in one file.
			const declaration =
				target.implementationId && target.source
					? [target.implementationId, target.source.path, target.source.line, target.source.column]
					: target.id;
			const id = JSON.stringify([
				reportId,
				consumerSource,
				file?.package ?? "(unknown)",
				target.package,
				consumerOwnership,
				targetOwnership,
				boundaryDecision,
				declaration,
			]);
			let finding = findings.get(id);
			if (!finding) {
				finding = {
					id,
					reportId,
					repository:
						report?.name ??
						(reportId === snapshot.repository.id ? snapshot.repository.name : reportId),
					consumerPackage: file?.package ?? "(unknown)",
					consumerSource,
					targetPackage: target.package,
					api: target,
					routes: [],
					consumerOwnership,
					targetOwnership,
					boundaryDecision,
					policyReason,
					assessment: boundaryDecision === "unresolved" ? "needs-review" : boundaryDecision,
					reasons: [],
					usages: [],
					consumerVersion,
					catalogVersion,
				};
				findings.set(id, finding);
			}
			if (!finding.routes.some((route) => route.id === target.id)) finding.routes.push(target);
			if (!finding.usages.some((usage) => usage.id === occurrence.id))
				finding.usages.push(occurrence);
			finding.reasons = [...new Set([...finding.reasons, ...reasons])];
			if (finding.reasons.length) finding.assessment = "needs-review";
		}
	}
	return [...findings.values()].sort(
		(a, b) =>
			a.targetPackage.localeCompare(b.targetPackage) ||
			a.repository.localeCompare(b.repository) ||
			(a.api.qualifiedName ?? a.api.label).localeCompare(b.api.qualifiedName ?? b.api.label) ||
			a.id.localeCompare(b.id),
	);
}
