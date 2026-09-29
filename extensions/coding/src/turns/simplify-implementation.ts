import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @internal */
export function buildSimplifyImplementationPrompt(
	_ctx: FlowPromptContext<unknown, StructuralProcessState>,
): string {
	return `Repository root: . (the current working directory)

Find worthwhile ways to simplify the current implementation and nearby code, reducing lines without reducing clarity or behavior. If the implementation is already appropriately simple, say so.

Inspect the repository read-only and publish a concise simplification plan. Do not modify any files.`;
}

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
