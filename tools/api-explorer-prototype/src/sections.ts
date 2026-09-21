/** @internal Bookmarkable top-level views; graph focus and filters remain session-local. */
export const sectionLinks = {
	graph: "#explorer",
	candidates: "#removal-candidates",
	dependencies: "#internal-api-dependencies",
	notes: "#all-notes",
} as const;

/** @internal */
export type ExplorerSection = keyof typeof sectionLinks;

/** @internal Empty and unknown fragments open the Explorer. */
export function sectionForHash(hash: string): ExplorerSection {
	if (hash === sectionLinks.candidates) return "candidates";
	if (hash === sectionLinks.notes) return "notes";
	if (hash === sectionLinks.dependencies) return "dependencies";
	return "graph";
}
