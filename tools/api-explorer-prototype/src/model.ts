/** @internal Tool-local snapshot schema. IDs never contain source positions. */
export interface Source {
	path: string;
	line: number;
	column: number;
	snippet: string;
	snippetStart?: number;
}
/** @internal Static wiring evidence does not prove runtime activation or use of a specific alias. */
export interface UsageEvidence {
	reportId?: string;
	kind: "default-export" | "extension-entry" | "binding" | "implementation" | "implementation-call";
	label: string;
	detail: string;
	source: Source;
	isTest?: boolean;
}
/** @internal */
export interface ApiNode {
	implementationId?: string;
	sideEffects?: boolean;
	keepReasons?: string[];
	id: string;
	label: string;
	kind: string;
	package: string;
	parentId?: string;
	entry?: string;
	qualifiedName?: string;
	release?: string;
	source?: Source;
	signatures?: string[];
	documentation?: string;
	extraction?: string;
	isTest?: boolean;
	group?: string;
	canonicalReference?: string;
	callable?: boolean;
	evidence?: UsageEvidence[];
}
/** @internal */
export interface Occurrence extends Source {
	routeTargets?: string[];
	reportId?: string;
	id: string;
	fileId: string;
	targets: string[];
	/** Import route or declaring package; shared export aliases are not dependencies. */
	targetPackages?: string[];
	kind: "call" | "type" | "other" | "import" | "re-export";
	isTest: boolean;
}
/** @internal */
export interface Snapshot {
	reportLoadingIncomplete?: boolean;
	reports?: {
		id: string;
		name: string;
		revision: string;
		fingerprint: string;
		producerVersion: string;
		analyzedPackages: Record<string, string>;
		compatible: boolean;
		complete: boolean;
	}[];
	version: 1;
	repository: { id: string; name: string; revision: string; dirty: boolean };
	generatedAt: string;
	coverage: {
		complete: boolean;
		sourceFiles: number;
		entryPoints: number;
		extractedEntryPoints: number;
		typescriptVersion: string;
		limitations: string[];
	};
	nodes: ApiNode[];
	occurrences: Occurrence[];
	relationships: { from: string; to: string; kind: string }[];
	diagnostics: { severity: string; scope: string; message: string }[];
}
/** @internal */
export interface Filters {
	query: string;
	package: string;
	public: boolean;
	internal: boolean;
	kind: string;
	tests: boolean;
	internalUsages: boolean;
}
/** @internal Usage scope is relative to the target API's package, not its release tag. */
export type UsageScope = "external" | "internal";
/** @internal Interfaces expose references as well as member calls. */
export type UsageMode = "calls" | "usages";
/** @internal */
export const usageMode = (node: ApiNode): UsageMode =>
	node.kind === "interface" ? "usages" : "calls";
/** @internal */
export const usageScope = (file: ApiNode, target: ApiNode): UsageScope =>
	file.package === target.package ? "internal" : "external";
/** @internal */
export const isApi = (node: ApiNode) => !["package", "entry", "file"].includes(node.kind);
/** @internal */
export function matches(node: ApiNode, filters: Filters) {
	return (
		(!filters.package || node.package === filters.package) &&
		(!filters.query ||
			`${node.label} ${node.qualifiedName ?? ""} ${node.package} ${node.source?.path ?? ""}`
				.toLowerCase()
				.includes(filters.query.toLowerCase())) &&
		(!filters.kind || node.kind === filters.kind) &&
		(!isApi(node) || (node.release === "internal" ? filters.internal : filters.public)) &&
		(filters.tests || !node.isTest)
	);
}
/** @internal */
export function indexSnapshot(snapshot: Snapshot) {
	const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
	const packages = snapshot.nodes.filter((n) => n.kind === "package" && n.source);
	// Older snapshots have no occurrence provenance. Attribute their symbols to
	// the declaration's package instead of every facade that re-exports them.
	const declaringPackages = new Map(
		snapshot.nodes.map((node) => [
			node.id,
			packages.find((pkg) =>
				node.source?.path.startsWith(pkg.source!.path.replace(/package\.json$/, "")),
			)?.package ?? node.package,
		]),
	);
	const children = new Map<string, ApiNode[]>(),
		usages = new Map<string, Occurrence[]>(),
		interfaceUsages = new Map<string, Occurrence[]>(),
		calls = new Map<string, Occurrence[]>(),
		fileUsages = new Map<string, Occurrence[]>();
	for (const node of snapshot.nodes)
		if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
	for (const occurrence of snapshot.occurrences) {
		const targetPackages = new Set(
			occurrence.targetPackages ?? occurrence.targets.map((id) => declaringPackages.get(id)),
		);
		const fileList = fileUsages.get(occurrence.fileId) ?? [];
		fileList.push(occurrence);
		fileUsages.set(occurrence.fileId, fileList);
		for (const target of occurrence.targets) {
			const list = usages.get(target) ?? [];
			list.push(occurrence);
			usages.set(target, list);
		}
		// Containers include members. Deduplicate aliases and shared ancestors.
		const owners = new Set<string>();
		for (const target of occurrence.targets) {
			let current = byId.get(target);
			while (current && !owners.has(current.id)) {
				owners.add(current.id);
				current = byId.get(current.parentId ?? "");
			}
		}
		for (const id of owners) {
			const owner = byId.get(id);
			if (
				occurrence.kind === "call" &&
				(owner?.kind !== "package" || targetPackages.has(owner.package))
			) {
				const list = calls.get(id) ?? [];
				list.push(occurrence);
				calls.set(id, list);
			}
			if (byId.get(id)?.kind === "interface") {
				const list = interfaceUsages.get(id) ?? [];
				list.push(occurrence);
				interfaceUsages.set(id, list);
			}
		}
	}
	return { byId, children, usages, calls, interfaceUsages, fileUsages, declaringPackages };
}
/** @internal Occurrences represented by a node's Callers or Usages action. */
export const nodeOccurrences = (node: ApiNode, index: ReturnType<typeof indexSnapshot>) =>
	(usageMode(node) === "usages" ? index.interfaceUsages : index.calls).get(node.id) ?? [];
/** @internal Explain evidence without equating lack of direct calls with dead code. */
export function usageInfo(
	node: ApiNode,
	index: ReturnType<typeof indexSnapshot>,
	visibleOccurrences: number,
) {
	const mode = usageMode(node);
	const occurrences = nodeOccurrences(node, index);
	const counts = {
		external: 0,
		internal: 0,
		tests: 0,
		references: (index.usages.get(node.id) ?? []).filter((o) => o.kind !== "call").length,
		imports: occurrences.filter((o) => o.kind === "import" || o.kind === "re-export").length,
	};
	for (const occurrence of occurrences) {
		const file = index.byId.get(occurrence.fileId);
		if (occurrence.isTest) counts.tests++;
		else if (file) counts[usageScope(file, node)]++;
	}
	if (mode === "usages") {
		return {
			mode,
			...counts,
			label: visibleOccurrences
				? "Indexed usages"
				: occurrences.length
					? "Usages filtered"
					: "No indexed usages",
			explanation: visibleOccurrences
				? "Usages include type references, member access and calls, imports, and re-exports. Select an occurrence to inspect its source."
				: occurrences.length
					? "Indexed usages are hidden by the current package, test, or API filters."
					: "No statically resolved usages were indexed. Structural compatibility and consumers outside this repository are not traced.",
		};
	}
	const evidence = node.evidence ?? [];
	const entry = evidence.some((item) => item.kind === "extension-entry");
	const implementationUsed = evidence.some(
		(item) => item.kind === "implementation-call" && !item.isTest,
	);
	const type = ["interface", "type"].includes(node.kind);
	const value =
		node.callable === false && ["variable", "property", "enum-member"].includes(node.kind);
	const label = entry
		? "Extension entry"
		: implementationUsed
			? "Shared implementation"
			: type
				? "Type references"
				: value
					? "Value export"
					: occurrences.length && !visibleOccurrences
						? "Calls filtered"
						: visibleOccurrences
							? "Indexed calls"
							: "No indexed calls";
	const explanation = entry
		? "This value is the declared extension entry. It can be consumed through dynamic module loading; runtime activation is not traced."
		: implementationUsed
			? "The implementation is called through other bindings. Those calls do not prove that this exported alias is used."
			: type
				? "Types are used through references. Callers can include calls to their members."
				: value
					? "This export is consumed as a value, so a direct function call is not expected. References and wiring show how it is exposed."
					: occurrences.length && !visibleOccurrences
						? "Indexed calls are hidden by the current caller, test, or API filters."
						: !visibleOccurrences
							? "No calls match the current filters. This does not establish that the export is unused; dynamic dispatch and out-of-repository consumers are not traced."
							: "Callers show statically resolved calls. References and wiring provide additional context.";
	return { mode, label, explanation, ...counts };
}
