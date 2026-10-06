/** Dependency-first traversal; callers resolve missing and optional dependencies. @internal */
export function orderDependencies(
	roots: Iterable<string>,
	dependencies: (id: string) => Iterable<string>,
	cycleMessage: (id: string) => string,
): string[] {
	const visiting = new Set<string>();
	const ordered = new Set<string>();
	function visit(id: string): void {
		if (ordered.has(id)) return;
		if (visiting.has(id)) throw new Error(cycleMessage(id));
		visiting.add(id);
		for (const dependency of dependencies(id)) visit(dependency);
		visiting.delete(id);
		ordered.add(id);
	}
	for (const id of roots) visit(id);
	return [...ordered];
}
