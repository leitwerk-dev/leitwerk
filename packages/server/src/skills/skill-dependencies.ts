import { SAFE_SKILL_ID_PATTERN } from "./skill-id.js";

const EXPLICIT_SKILL_REFERENCE =
	/\/([A-Za-z0-9][A-Za-z0-9._-]{0,83})|`([A-Za-z0-9][A-Za-z0-9._-]{0,83})`/g;

export function explicitSkillReferenceIds(markdown: string): string[] {
	const references = new Set<string>();
	for (const match of markdown.matchAll(EXPLICIT_SKILL_REFERENCE)) {
		let id = match[1] ?? match[2];
		while (id?.endsWith(".")) id = id.slice(0, -1);
		if (id && SAFE_SKILL_ID_PATTERN.test(id)) references.add(id);
	}
	return [...references];
}

export function referencedSkillIds(
	markdown: string,
	availableSkillIds: ReadonlySet<string>,
): string[] {
	return explicitSkillReferenceIds(markdown).filter((id) => availableSkillIds.has(id));
}
