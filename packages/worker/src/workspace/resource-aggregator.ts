export function formatProvenanceMarker(componentKey: string, filePath: string): string {
	const normalizedPath = filePath.replace(/\\/g, "/");
	return `<!-- source: ${componentKey}/${normalizedPath} -->`;
}

export function aggregateAgentsMd(
	sources: Array<{ componentKey: string; filePath: string; content: string }>,
): string {
	const sorted = [...sources].sort((a, b) => a.componentKey.localeCompare(b.componentKey));
	if (sorted.length === 0) {
		return "";
	}
	const parts: string[] = [];
	for (const s of sorted) {
		parts.push(formatProvenanceMarker(s.componentKey, s.filePath));
		parts.push(s.content.trimEnd());
	}
	return `${parts.join("\n\n").trimEnd()}\n`;
}

export function collectSkills(
	sources: Array<{ componentKey: string; skillId: string; content: string }>,
): Map<string, { content: string; source: string }> {
	const byId = new Map<string, Array<{ componentKey: string; skillId: string; content: string }>>();
	for (const s of sources) {
		const list = byId.get(s.skillId);
		if (list) {
			list.push(s);
		} else {
			byId.set(s.skillId, [s]);
		}
	}
	const out = new Map<string, { content: string; source: string }>();
	for (const [skillId, group] of byId) {
		group.sort((a, b) => a.componentKey.localeCompare(b.componentKey));
		const winner = group[0];
		out.set(skillId, {
			content: winner.content,
			source: winner.componentKey,
		});
	}
	return out;
}
