import { type ApiNode, type Occurrence, type Snapshot } from "./model";

/** @internal Advisory evidence, not a policy violation or proof of runtime execution. */
export interface InternalDependency {
	id: string;
	reportId: string;
	repository: string;
	consumerPackage: string;
	targetPackage: string;
	api: ApiNode;
	routes: ApiNode[];
	assessment: "warning" | "needs-review";
	reasons: string[];
	usages: Occurrence[];
	consumerVersion?: string;
	catalogVersion?: string;
}

/** @internal Analyze all loaded evidence; display filters must not alter classification. */
export function internalDependencies(snapshot: Snapshot): InternalDependency[] {
	const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
	const reports = new Map(snapshot.reports?.map((report) => [report.id, report]));
	const catalog = reports.get(snapshot.repository.id);
	const findings = new Map<string, InternalDependency>();
	for (const occurrence of snapshot.occurrences) {
		const reportId = occurrence.reportId ?? snapshot.repository.id;
		const report = reports.get(reportId);
		const file = nodes.get(occurrence.fileId);
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
			// A package importing itself is not an external dependency.
			if (file?.package === target.package) continue;
			const consumerVersion = report?.analyzedPackages[target.package];
			const catalogVersion = catalog?.analyzedPackages[target.package];
			const reasons: string[] = [];
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
				file?.package ?? "(unknown)",
				target.package,
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
					targetPackage: target.package,
					api: target,
					routes: [],
					assessment: "warning",
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
			a.repository.localeCompare(b.repository) ||
			a.targetPackage.localeCompare(b.targetPackage) ||
			(a.api.qualifiedName ?? a.api.label).localeCompare(b.api.qualifiedName ?? b.api.label) ||
			a.id.localeCompare(b.id),
	);
}
