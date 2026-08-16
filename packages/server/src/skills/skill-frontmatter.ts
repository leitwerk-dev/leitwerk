import { parse as parseYaml } from "yaml";

function frontmatter(markdown: string): Record<string, unknown> | null {
	if (!markdown.startsWith("---")) return null;
	const end = markdown.indexOf("\n---", 3);
	if (end < 0) return null;
	try {
		const parsed = parseYaml(markdown.slice(3, end));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function isSkillModelInvocable(markdown: string): boolean {
	return frontmatter(markdown)?.["disable-model-invocation"] !== true;
}
