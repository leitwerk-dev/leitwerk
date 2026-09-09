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
	const out = new Map<string, { content: string; source: string }>();
	for (const { skillId, componentKey, content } of sources) {
		const winner = out.get(skillId);
		if (!winner || componentKey.localeCompare(winner.source) < 0) {
			out.set(skillId, { content, source: componentKey });
		}
	}
	return out;
}
