import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

/** @internal */
export function buildImplementPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState, "plan">,
): string {
	return `Implement this requested change:
${ctx.prompts.initial}

Repository checkouts: ${ctx.repo
		.all()
		.map((repo) => `${repo.key}: ${repo.fsPath}`)
		.join("; ")}

Follow this plan:
${ctx.input.plan}

Rules:
- keep going until the change is complete; do any necessary additional passes without asking
- make repository changes only inside the current working directory
- run file edits, Git commands, and checks in the appropriate checkout
- follow each repository’s instructions and validate every affected repository
- leave changes uncommitted; delivery owns commits and pushes
- do not read from or write to any original source repository path outside the process workspace
- keep the implementation coherent and complete
- keep the number of changed files small
- when documenting, be sparse. Do not narrate the implementation or maintain a prose inventory of tests, helpers, internal environment variables, or cleanup mechanics.
- publish the implementation summary when done`;
}
