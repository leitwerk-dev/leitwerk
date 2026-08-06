import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

export function buildSimplifyImplementationPrompt(
	_ctx: FlowPromptContext<unknown, StructuralProcessState>,
): string {
	return `Repository root: . (the current working directory)

Find worthwhile ways to simplify the current implementation and nearby code, reducing lines without reducing clarity or behavior. If the implementation is already appropriately simple, say so.

Inspect the repository read-only and publish a concise simplification plan. Do not modify any files.`;
}
