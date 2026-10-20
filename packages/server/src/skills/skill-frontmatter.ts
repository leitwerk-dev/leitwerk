import { parse as parseYaml } from "yaml";

/** @internal */
export function skillFrontmatter(markdown: string): Record<string, unknown> | null {
	const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!header) return null;
	try {
		const parsed = parseYaml(header[1]);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function isSkillModelInvocable(markdown: string): boolean {
	return skillFrontmatter(markdown)?.["disable-model-invocation"] !== true;
}

/** @internal */
export function skillMetadata(markdown: string): {
	name: string | null;
	description: string | null;
} {
	const metadata = skillFrontmatter(markdown);
	const text = (key: string): string | null => {
		const value = metadata?.[key];
		return typeof value === "string" ? value.trim() || null : null;
	};
	return { name: text("name"), description: text("description") };
}
