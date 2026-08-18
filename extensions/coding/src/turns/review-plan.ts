import type { FlowPromptContext, StructuralProcessState } from "@leitwerk-dev/process-sdk";

export function buildReviewPlanPrompt(
	ctx: FlowPromptContext<unknown, StructuralProcessState, "plan">,
): string {
	return `Review the plan against this requested change:
${ctx.prompts.initial}

Repository root: . (the current working directory)

Plan:
${ctx.input.plan}

Rules:
- review the plan only; do not rewrite the plan
- if you inspect repository files for context, read only inside the current working directory
- use bash only for read-only inspection (e.g. git diff, git status, rg, tree, file listing, read-only http/CLI calls)
- do not modify files, branches, commits, or git index state
- do not read from or write to any original source repository path outside the process workspace
- evaluate scope, sequencing, risks, and acceptance criteria
- publish a short Markdown approval note when the plan is solid
- publish concise, actionable Markdown feedback when the plan needs changes`;
}
