import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

export function buildReviewImplementationPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState>,
): string {
	const repo = ctx.repo.get("repo");
	return `Repository root: . (the current working directory)

Review the current implementation of this requested change:
${ctx.prompts.initial}

Inspect the changes with \`git diff --stat $(git merge-base ${repo.baseBranch} HEAD)\`. Check for:
- bugs and logic errors
- security issues
- error handling gaps
- missing or misplaced tests
- unnecessary abstractions, duplication, and other avoidable complexity

For each issue, give a concise fix.

Rules:
- inspect code only inside the current working directory
- treat . as the repository root for read-only inspection
- use bash only for read-only inspection (e.g. git diff, git status, rg, tree, file listing, read-only http/CLI calls)
- do not modify files, branches, commits, or git index state
- do not read from or write to any original source repository path outside the process workspace
- publish a short Markdown approval note if the implementation is ready
- publish concise, actionable Markdown feedback if the implementation needs changes`;
}
