import { type ApiNode, indexSnapshot, isApi, type Occurrence, type Snapshot } from "./model";

/** @internal Stable codes shared by the UI, export, and read-only API. */
export const changeLabels = {
	"make-file-local": "Make file-local",
	"reduce-package-exposure": "Reduce package exposure",
	"consider-declaration-deletion": "Consider declaration deletion",
	"no-reduction-established": "No reduction established",
} as const;
/** @internal */
export const assessmentLabels = {
	candidate: "Candidate",
	"migration-required": "Migration required",
	"review-required": "Review required",
	retain: "Retain",
} as const;
/** @internal */
export const constraintLabels = {
	"compatibility-contract": "Public/preview compatibility review",
	"unknown-release": "Unknown release metadata",
	"runtime-entry": "Required runtime entry",
	"exported-signature": "Retained by exported signature",
	"incomplete-coverage": "Incomplete loaded-source coverage",
	"unresolved-route": "Unresolved consumer route",
	"unknown-consumer": "Unknown consumer package",
	"default-export": "Default export: runtime role unverified",
	"implementation-wiring": "Shared implementation wiring",
	"side-effects": "Initializer may have side effects",
} as const;
/** @internal */
export type ProposedChange = keyof typeof changeLabels;
/** @internal */
export type Assessment = keyof typeof assessmentLabels;
/** @internal */
export interface Constraint {
	code: keyof typeof constraintLabels;
	appliesTo: "package-exposure" | "module-export" | "declaration-deletion";
	routeId?: string;
	ownerIds?: string[];
	detail: string;
}
/** @internal */
export interface MigrationRequirement {
	code: "rewrite-same-package-imports" | "preserve-module-access" | "separate-entry-facade";
	occurrenceIds: string[];
	detail: string;
}
/** @internal Findings are proposals scoped to all loaded sources, never proof of dead code. */
export interface Candidate {
	id: string;
	node: ApiNode;
	declaringPackage: string;
	proposedChange: ProposedChange;
	assessment: Assessment;
	action: (typeof changeLabels)[ProposedChange];
	reason: string;
	constraints: Constraint[];
	retainingApiIds: string[];
	observedUsage: string[];
	declarationAssessment: "retain" | "review-required" | "candidate";
	routes: {
		id: string;
		package: string;
		entry: string;
		used: boolean;
		productionUsed: boolean;
		testUsed: boolean;
		action: string;
		assessment: Assessment;
		constraints: Constraint[];
		migrationRequirements: MigrationRequirement[];
	}[];
	usages: Occurrence[];
	cleanup: Occurrence[];
	reports: string[];
	scopes: string[];
	compatibility: string;
}
/** @internal Incomplete evidence blocks every absence-based change, not positive retention. */
export function absenceBlocked(snapshot: Snapshot): boolean {
	return (
		!snapshot.coverage.complete ||
		!!snapshot.reportLoadingIncomplete ||
		!!snapshot.reports?.some((r) => !r.complete || !r.compatible)
	);
}
/** @internal Does not accept display filters: findings always use every loaded source. */
export function removalCandidates(snapshot: Snapshot): Candidate[] {
	const index = indexSnapshot(snapshot);
	const declarations = snapshot.nodes.filter(
		(n) => isApi(n) && index.byId.get(n.parentId ?? "")?.kind === "entry",
	);
	const groups = new Map<string, ApiNode[]>();
	for (const node of declarations) {
		const key = node.implementationId ?? node.id;
		groups.set(key, [...(groups.get(key) ?? []), node]);
	}
	return [...groups.values()]
		.map((group): Candidate => {
			const aliases = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			const node = aliases[0];
			const ids = new Set(aliases.map((n) => n.id));
			const descend = (id: string) => {
				for (const child of index.children.get(id) ?? [])
					if (!ids.has(child.id)) {
						ids.add(child.id);
						descend(child.id);
					}
			};
			for (const alias of aliases) descend(alias.id);
			const references = [
				...new Map(
					[...ids].flatMap((id) => index.usages.get(id) ?? []).map((o) => [o.id, o]),
				).values(),
			];
			const consumers = references.filter((o) => o.kind !== "re-export");
			const declaringPackage = index.declaringPackages.get(node.id) ?? node.package;
			const internal = consumers.filter(
				(o) => index.byId.get(o.fileId)?.package === declaringPackage,
			);
			const external = consumers.filter(
				(o) => index.byId.get(o.fileId)?.package !== declaringPackage,
			);
			const retainingApiIds = [
				...new Set(
					snapshot.relationships
						.filter((r) => r.kind === "type" && ids.has(r.to) && !ids.has(r.from))
						.map((r) => r.from),
				),
			].sort();
			const constraints: Constraint[] = [];
			const add = (
				code: Constraint["code"],
				appliesTo: Constraint["appliesTo"],
				detail: string,
				extra: Partial<Constraint> = {},
			) => {
				constraints.push({ code, appliesTo, detail, ...extra });
			};
			if (absenceBlocked(snapshot))
				for (const scope of ["package-exposure", "module-export", "declaration-deletion"] as const)
					add(
						"incomplete-coverage",
						scope,
						"Loaded reports are incomplete, incompatible, or unreadable. Positive evidence remains valid; absence is not established.",
					);
			if (retainingApiIds.length)
				for (const scope of ["module-export", "declaration-deletion"] as const)
					add(
						"exported-signature",
						scope,
						`Required by: ${retainingApiIds.map((id) => index.byId.get(id)?.qualifiedName ?? index.byId.get(id)?.label ?? id).join(", ")}`,
						{ ownerIds: retainingApiIds },
					);
			if (consumers.some((o) => !index.byId.has(o.fileId)))
				for (const scope of ["package-exposure", "module-export", "declaration-deletion"] as const)
					add("unknown-consumer", scope, "A consumer's file/package metadata is missing.");
			if (
				external.some(
					(o) =>
						!o.routeTargets?.length ||
						o.routeTargets.some((id) => !aliases.some((n) => n.id === id)),
				)
			)
				add(
					"unresolved-route",
					"package-exposure",
					"A cross-package consumer cannot be assigned completely to known export routes.",
				);
			for (const alias of aliases) {
				if (alias.release !== "internal")
					add(
						alias.release ? "compatibility-contract" : "unknown-release",
						"package-exposure",
						alias.release
							? `Release tag ${alias.release} requires compatibility review.`
							: "Classify the release contract before reducing exposure.",
						{ routeId: alias.id },
					);
				const runtime =
					alias.keepReasons?.length || alias.evidence?.some((e) => e.kind === "extension-entry");
				if (runtime)
					for (const scope of [
						"package-exposure",
						"module-export",
						"declaration-deletion",
					] as const)
						add(
							"runtime-entry",
							scope,
							alias.keepReasons?.join("; ") ||
								"Declared dynamic entry; static callers do not establish its runtime activation.",
							{ routeId: alias.id },
						);
				else if (alias.evidence?.some((e) => e.kind === "default-export"))
					add(
						"default-export",
						"package-exposure",
						"Default export alone does not establish a runtime role. Verify loading before removing this route.",
						{ routeId: alias.id },
					);
				if (alias.evidence?.some((e) => e.kind === "implementation-call"))
					add(
						"implementation-wiring",
						"declaration-deletion",
						"Shared implementation calls do not prove use of this alias.",
						{ routeId: alias.id },
					);
				if (alias.sideEffects)
					add(
						"side-effects",
						"declaration-deletion",
						"Preserve initializer effects or review them before deletion.",
						{ routeId: alias.id },
					);
			}
			const routes = aliases.map((alias): Candidate["routes"][number] => {
				const usedBy = external.filter((o) => o.routeTargets?.includes(alias.id));
				const routeConstraints = constraints.filter(
					(c) => c.appliesTo === "package-exposure" && (!c.routeId || c.routeId === alias.id),
				);
				const imports = internal.filter(
					(o) =>
						o.kind === "import" && (!o.routeTargets?.length || o.routeTargets.includes(alias.id)),
				);
				const otherFiles = internal.filter((o) => o.path !== alias.source?.path);
				const migrationRequirements: MigrationRequirement[] = [];
				if (imports.length)
					migrationRequirements.push({
						code: "rewrite-same-package-imports",
						occurrenceIds: imports.map((o) => o.id),
						detail:
							"Rewrite imports using this package route to preserved module access; unresolved same-package imports must be checked.",
					});
				if (otherFiles.length)
					migrationRequirements.push({
						code: "preserve-module-access",
						occurrenceIds: otherFiles.map((o) => o.id),
						detail: "Keep the module export needed by other files, including tests.",
					});
				const entrySource = index.byId.get(alias.parentId ?? "")?.source?.path;
				if (entrySource && entrySource === alias.source?.path)
					migrationRequirements.push({
						code: "separate-entry-facade",
						occurrenceIds: [],
						detail:
							"This entry directly exposes the declaring module. Separate the package facade before reducing exposure while retaining module access.",
					});
				const assessment: Assessment =
					usedBy.length || routeConstraints.some((c) => c.code === "runtime-entry")
						? "retain"
						: routeConstraints.length
							? "review-required"
							: migrationRequirements.length
								? "migration-required"
								: "candidate";
				return {
					id: alias.id,
					package: alias.package,
					entry: `${alias.package}${alias.entry === "." ? "" : (alias.entry?.slice(1) ?? "")}`,
					used: !!usedBy.length,
					productionUsed: usedBy.some((o) => !o.isTest),
					testUsed: usedBy.some((o) => o.isTest),
					action: assessment === "retain" ? "Retain export" : assessmentLabels[assessment],
					assessment,
					constraints: routeConstraints,
					migrationRequirements,
				};
			});
			const runtime = constraints.some((c) => c.code === "runtime-entry");
			const declarationAssessment =
				consumers.length || retainingApiIds.length || runtime
					? "retain"
					: constraints.length
						? "review-required"
						: "candidate";
			const openRoutes = routes.filter((r) => r.assessment !== "retain");
			const actionableRoutes = openRoutes.filter((r) => r.assessment !== "review-required");
			const sameFile =
				!!node.source &&
				consumers.length > 0 &&
				consumers.every(
					(o) =>
						internal.includes(o) &&
						o.path === node.source!.path &&
						(!o.reportId || o.reportId === snapshot.reports?.[0]?.id),
				);
			let proposedChange: ProposedChange = "no-reduction-established";
			let assessment: Assessment = "retain";
			if (openRoutes.length) {
				proposedChange = "reduce-package-exposure";
				assessment = actionableRoutes.length
					? actionableRoutes.some((r) => r.assessment === "migration-required")
						? "migration-required"
						: "candidate"
					: "review-required";
				if (
					actionableRoutes.length === routes.length &&
					!constraints.some((c) => c.appliesTo === "module-export") &&
					sameFile
				)
					proposedChange = "make-file-local";
				if (!consumers.length && !constraints.length)
					proposedChange = "consider-declaration-deletion";
			}
			const observedUsage = [
				...new Set(
					consumers.map((o) => {
						const scope = !index.byId.has(o.fileId)
							? "unknown-package"
							: internal.includes(o)
								? o.path === node.source?.path
									? "file-local"
									: "same-package"
								: "cross-package";
						return `${scope}-${o.isTest ? "tests" : "production"}`;
					}),
				),
			].sort();
			if (consumers.length && consumers.every((o) => o.isTest))
				observedUsage.push("only-test-consumers-observed");
			if (!consumers.length) observedUsage.push("no-consumers-observed");
			const reason =
				`${actionableRoutes.length} route(s) potentially reducible; ${routes.filter((r) => r.assessment === "retain").length} retained; ${routes.filter((r) => r.assessment === "review-required").length} require review. ` +
				(proposedChange === "make-file-local"
					? "Preserve the declaration and local references."
					: proposedChange === "consider-declaration-deletion"
						? "No consumers observed in loaded sources. Verify runtime use before deleting."
						: "Keep the module export when consumers or signatures require it; reduce only the identified routes.") +
				(constraints.length ? ` ${[...new Set(constraints.map((c) => c.detail))].join(" ")}` : "");
			return {
				id: node.id,
				node,
				declaringPackage,
				proposedChange,
				assessment,
				action: changeLabels[proposedChange],
				reason,
				constraints,
				retainingApiIds,
				observedUsage,
				declarationAssessment,
				routes,
				usages: references.filter((o) => o.kind !== "import" && o.kind !== "re-export"),
				cleanup: references.filter((o) => o.kind === "import" || o.kind === "re-export"),
				reports: [
					...new Set([
						...(snapshot.reports?.map((r) => r.id) ?? []),
						...references.flatMap((o) => (o.reportId ? [o.reportId] : [])),
					]),
				],
				scopes: observedUsage,
				compatibility: aliases.every((n) => n.release === "internal")
					? "Internal API"
					: aliases.some((n) => !n.release)
						? "Unknown release metadata; review required"
						: "Public/preview API: compatibility review required",
			};
		})
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
