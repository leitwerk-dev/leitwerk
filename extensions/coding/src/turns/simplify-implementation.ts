import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @internal */
export function buildStreamlinedSimplificationPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState>,
): string {
	return `Review all uncommitted changes in this repo: staged, unstaged, and untracked files. Analyze what could be simplified to reduce the number of lines.
Also look a bit around the current changes to identify points to save lines.

Apply this instruction to each checkout: ${ctx.repo
		.all()
		.map((repo) => `${repo.key}: ${repo.fsPath}`)
		.join(
			"; ",
		)}. Label findings by repository. Inspect read-only; do not edit, stage, commit, or push. Publish findings even when there are none.`;
}
