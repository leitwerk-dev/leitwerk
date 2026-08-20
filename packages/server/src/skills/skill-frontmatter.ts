import { parseFrontmatter, type SkillFrontmatter } from "@earendil-works/pi-coding-agent";

export function skillFrontmatter(markdown: string): SkillFrontmatter {
	try {
		return parseFrontmatter<SkillFrontmatter>(markdown).frontmatter;
	} catch {
		return {};
	}
}

export function isSkillModelInvocable(markdown: string): boolean {
	return skillFrontmatter(markdown)["disable-model-invocation"] !== true;
}
