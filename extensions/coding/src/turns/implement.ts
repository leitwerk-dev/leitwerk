import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

export function buildImplementPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState, "plan">,
): string {
	return `Implement this requested change:
${ctx.prompts.initial}

Repository root: . (the current working directory)

Follow this plan:
${ctx.input.plan}

Rules:
- keep going until the change is complete; do any necessary additional passes without asking
- make repository changes only inside the current working directory
- treat . as the repository root for file edits and git commands
- do not read from or write to any original source repository path outside the process workspace
- keep the implementation coherent and complete
- publish the implementation summary when done`;
}
