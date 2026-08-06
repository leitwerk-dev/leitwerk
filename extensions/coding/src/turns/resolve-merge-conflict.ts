import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

export function buildResolveMergeConflictPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState, never>,
): string {
	const repo = ctx.repo.get("repo");
	return `Resolve the current merge conflict so this requested change can be finalized:
${ctx.prompts.initial}

Repository root: . (the current working directory)

Branches:
- base branch: ${repo.baseBranch}
- work branch: ${repo.workBranch}

Rules:
- resolve only the current merge conflict inside the current working directory
- treat . as the repository root for file edits and git commands
- complete the merge commit so the repository is no longer in a merge-in-progress state
- leave the repository clean when you finish
- do not push
- do not read from or write to any original source repository path outside the process workspace
- publish a concise Markdown summary of the merge resolution
- then call clean with the final HEAD sha`;
}
