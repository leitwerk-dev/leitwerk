import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @internal */
export function buildGeneratePlanPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState, never>,
): string {
	const repos = ctx.repo.all();
	if (repos.length !== 1 || repos[0]?.key !== "repo")
		return `Create one coordinated implementation plan for this change:
${ctx.prompts.initial}

Repositories:
${repos.map((repo) => `${repo.key}: ${repo.fsPath} (base ${repo.baseBranch}; work ${repo.workBranch})`).join("\n")}

Inspect every checkout read-only. Label repository-specific work. Follow each repository's instructions. Do not edit, commit, push, or inspect original repositories outside this workspace. Publish the plan when done.`;
	const repo = ctx.repo.get("repo");
	return `Create an implementation plan for this repository change:
${ctx.prompts.initial}

Repository root: . (the current working directory)

Branches:
- base branch: ${repo.baseBranch}
- work branch: ${repo.workBranch}

Rules:
- analyze only the cloned repository in the current working directory
- treat . as the repository root for read-only inspection
- use bash only for read-only inspection (e.g. git log, git diff, rg, tree, file listing, read-only http/CLI calls)
- do not modify files
- do not read from or write to any original source repository path outside the process workspace
- publish the plan when done`;
}
