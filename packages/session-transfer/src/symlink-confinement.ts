import path from "node:path";

/** Resolve each component before interpreting '..', including targets that do not exist yet. */
export function assertConfinedSymlinks(links: ReadonlyMap<string, string>): void {
	const resolvedLinks = new Map<string, string[]>();
	const resolving = new Set<string>();
	const resolve = (segments: readonly string[], initial: readonly string[] = []): string[] => {
		let resolved = [...initial];
		for (const segment of segments) {
			if (segment === "" || segment === ".") continue;
			if (segment === "..") {
				if (resolved.length === 0) throw new Error("Symlink escapes the workspace");
				resolved.pop();
				continue;
			}
			const candidate = [...resolved, segment].join("/");
			const target = links.get(candidate);
			if (target === undefined) {
				resolved.push(segment);
				continue;
			}
			if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
				throw new Error(`Absolute symlink is not portable: ${candidate}`);
			}
			if (resolving.has(candidate)) throw new Error(`Symlink cycle in workspace: ${candidate}`);
			let destination = resolvedLinks.get(candidate);
			if (!destination) {
				resolving.add(candidate);
				destination = resolve(target.split("/"), resolved);
				resolving.delete(candidate);
				resolvedLinks.set(candidate, destination);
			}
			resolved = [...destination];
		}
		return resolved;
	};
	for (const name of links.keys()) resolve(name.split("/"));
}
