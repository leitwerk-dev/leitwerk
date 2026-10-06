import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @internal */
export function buildGeneratePlanPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState, never>,
): string {
	return `Create one coordinated implementation plan for this change:
${ctx.prompts.initial}

Repository checkouts: ${ctx.repo
		.all()
		.map((repo) => `${repo.key}: ${repo.fsPath}`)
		.join("; ")}

Rules:
- follow each repository's instructions
- use bash only for read-only inspection (e.g. git log, git diff, rg, tree, file listing, read-only http/CLI calls)
- label repository-specific work when planning across multiple repositories
- do not modify files, commit, or push
- keep the number of changed files small
- publish the plan when done`;
}
