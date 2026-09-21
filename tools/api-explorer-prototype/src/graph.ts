import {
	type ApiNode,
	type Filters,
	type indexSnapshot,
	isApi,
	matches,
	nodeOccurrences,
	type Occurrence,
	type Snapshot,
	type UsageMode,
	type UsageScope,
	usageMode,
	usageScope,
} from "./model";
/** @internal */
export type SnapshotIndex = ReturnType<typeof indexSnapshot>;
/** @internal */
export interface View {
	root: string;
	limits: Record<string, number>;
	expanded: string[];
	hidden: string[];
	siteLimits: Record<string, number>;
}
/** @internal Entry points retain identity in the snapshot but add no visual layer. */
export function graphChildren(index: SnapshotIndex, id: string): ApiNode[] {
	return (index.children.get(id) ?? []).flatMap((node) =>
		node.kind === "entry" ? graphChildren(index, node.id) : [node],
	);
}
/** @internal */
export function buildGraph(snapshot: Snapshot, index: SnapshotIndex, view: View, filters: Filters) {
	const selected = new Map<string, ApiNode>(),
		links = new Map<
			string,
			{ id: string; source: string; target: string; label: string; usageScope?: UsageScope }
		>();
	const hidden = new Set(view.hidden);
	const allowed = (n: ApiNode) =>
		!hidden.has(n.id) &&
		matches(n, {
			...filters,
			query: "",
			kind: ["package", "entry"].includes(n.kind) ? "" : filters.kind,
		});
	const connect = (from: string, to: string, label: string, scope?: UsageScope) => {
		const id = `${from}->${to}`;
		links.set(id, {
			id,
			source: from,
			target: to,
			label,
			...(scope ? { usageScope: scope } : {}),
		});
	};
	const childrenFor = (node: ApiNode) => {
		const candidates = graphChildren(index, node.id).filter(allowed);
		if (isApi(node)) {
			for (const rel of snapshot.relationships)
				if (rel.from === node.id) {
					const target = index.byId.get(rel.to);
					if (target && allowed(target) && !candidates.some((n) => n.id === target.id))
						candidates.push(target);
				}
		}
		return candidates;
	};
	const more: Record<string, number> = {};
	const moreSites: Record<string, number> = {},
		siteCounts: Record<string, number> = {};
	const fileOccurrences = new Map<string, Occurrence[]>();
	const fileScopes = new Map<string, UsageScope | "mixed">();
	const fileModes = new Map<string, UsageMode>();
	const occurrencesFor = (node: ApiNode) =>
		nodeOccurrences(node, index).filter((occurrence) => {
			const file = index.byId.get(occurrence.fileId);
			return (
				file &&
				(usageScope(file, node) === "external" ||
					(node.kind !== "package" && filters.internalUsages)) &&
				(filters.tests || !occurrence.isTest) &&
				occurrence.targets.some((target) => {
					const api = index.byId.get(target);
					return api && matches(api, { ...filters, query: "", kind: "" });
				})
			);
		});
	const expanded = new Set(view.expanded);
	if (view.root) expanded.add(view.root);
	const visited = new Set<string>();
	function expand(node: ApiNode) {
		selected.set(node.id, node);
		if (visited.has(node.id)) return;
		visited.add(node.id);
		if (expanded.has(node.id)) {
			const candidates = childrenFor(node),
				limit = view.limits[node.id] ?? 6;
			const children = new Set(graphChildren(index, node.id).map((child) => child.id));
			more[node.id] = Math.max(0, candidates.length - limit);
			for (const child of candidates.slice(0, limit)) {
				connect(node.id, child.id, children.has(child.id) ? "contains" : "type");
				expand(child);
			}
		}
		const sites = occurrencesFor(node);
		siteCounts[node.id] = sites.length;
		const siteLimit = view.siteLimits?.[node.id];
		if (siteLimit === undefined) return;
		const files = new Map<string, Occurrence[]>();
		for (const occurrence of sites) {
			if (hidden.has(occurrence.fileId)) continue;
			const list = files.get(occurrence.fileId) ?? [];
			list.push(occurrence);
			files.set(occurrence.fileId, list);
		}
		moreSites[node.id] = Math.max(0, files.size - siteLimit);
		for (const [id, occurrences] of [...files]
			.sort(
				(a, b) =>
					Number(index.byId.get(a[0])?.package === node.package) -
						Number(index.byId.get(b[0])?.package === node.package) ||
					b[1].length - a[1].length ||
					a[0].localeCompare(b[0]),
			)
			.slice(0, siteLimit)) {
			const file = index.byId.get(id);
			if (!file) continue;
			selected.set(id, file);
			const scope = usageScope(file, node);
			const mode = usageMode(node);
			connect(
				id,
				node.id,
				`${occurrences.length} ${scope}${mode === "usages" ? " usages" : ""}`,
				scope,
			);
			const previousScope = fileScopes.get(id);
			fileScopes.set(id, previousScope && previousScope !== scope ? "mixed" : scope);
			fileModes.set(id, fileModes.get(id) === "usages" ? "usages" : mode);
			const merged = new Map((fileOccurrences.get(id) ?? []).map((o) => [o.id, o]));
			for (const occurrence of occurrences) merged.set(occurrence.id, occurrence);
			fileOccurrences.set(id, [...merged.values()]);
		}
	}
	if (view.root) {
		let node = index.byId.get(view.root);
		if (node?.kind === "entry") node = index.byId.get(node.parentId ?? "");
		if (node) expanded.add(node.id);
		if (node && !hidden.has(node.id)) expand(node);
	} else {
		const packages = snapshot.nodes.filter((n) => n.kind === "package" && allowed(n));
		const limit = view.limits.overview ?? 8;
		more.overview = Math.max(0, packages.length - limit);
		for (const pkg of packages.slice(0, limit)) expand(pkg);
		const packageIds = new Map(packages.map((p) => [p.package, p.id]));
		const aggregates = new Map<string, { from: string; to: string; count: number }>();
		for (const occurrence of snapshot.occurrences) {
			if (!filters.tests && occurrence.isTest) continue;
			const file = index.byId.get(occurrence.fileId),
				from = packageIds.get(file?.package ?? "");
			if (!from || !selected.has(from)) continue;
			const targets = occurrence.targets
				.map((id) => index.byId.get(id))
				.filter((n): n is ApiNode => Boolean(n && allowed(n)));
			if (!targets.length) continue;
			const targetPackages = new Set(
				occurrence.targetPackages ?? targets.map((n) => index.declaringPackages.get(n.id)!),
			);
			for (const pkg of targetPackages) {
				const to = packageIds.get(pkg);
				if (!to || to === from || !selected.has(to)) continue;
				const key = `${from}->${to}`;
				const aggregate = aggregates.get(key) ?? { from, to, count: 0 };
				aggregate.count++;
				aggregates.set(key, aggregate);
			}
		}
		for (const value of aggregates.values()) connect(value.from, value.to, `${value.count}`);
	}
	return {
		nodes: [...selected.values()],
		edges: [...links.values()].filter((e) => selected.has(e.source) && selected.has(e.target)),
		more,
		moreSites,
		siteCounts,
		fileOccurrences,
		fileScopes,
		fileModes,
		occurrencesFor,
		childrenFor,
	};
}
